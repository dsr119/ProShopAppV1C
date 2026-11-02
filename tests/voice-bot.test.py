import contextlib
import importlib.util
import io
import json
import os
import unittest
import urllib.error
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location('voice', Path(__file__).resolve().parents[1] / 'voice/shop_voice.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)

CFG = dict(voice.DEFAULTS, password='pw', location='South Side')


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def frame(level):
    return np.full(voice.FRAME, level, np.int16)


class PostTurnTests(unittest.TestCase):
    def test_sends_text_state_location_and_password(self):
        sent = {}

        def opener(req, timeout):
            sent.update(body=json.loads(req.data), secret=req.get_header('X-alexa-secret'), url=req.full_url)
            return FakeResponse(b'{"done": false, "say": "What are we doing?", "state": "s2"}')

        reply = voice.post_turn(CFG, 'for Doug Smith', 's1', opener)
        self.assertEqual(reply['say'], 'What are we doing?')
        self.assertEqual(sent['body'], {'text': 'for Doug Smith', 'location': 'South Side', 'model': 'haiku', 'state': 's1'})
        self.assertEqual(sent['secret'], 'pw')
        voice.post_turn(CFG, 'change it', 's1', opener, resume=True)
        self.assertEqual(sent['body']['resume'], True)
        self.assertEqual(sent['url'], CFG['function_url'])

    def test_first_turn_has_no_state(self):
        sent = {}

        def opener(req, timeout):
            sent.update(json.loads(req.data))
            return FakeResponse(b'{"done": true, "say": "Work order added."}')

        voice.post_turn(CFG, 'work order for Doug Smith to plug his ball', None, opener)
        self.assertNotIn('state', sent)

    def test_wrong_password_is_spoken(self):
        def opener(req, timeout):
            body = io.BytesIO(b'{"error": "Wrong password (got 3 characters, expected 20)"}')
            raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', {}, body)

        reply = voice.post_turn(CFG, 'hi', None, opener)
        self.assertTrue(reply['done'])
        self.assertIn('Wrong password', reply['say'])

    def test_no_connection_says_use_the_app(self):
        def opener(req, timeout):
            raise urllib.error.URLError('offline')

        reply = voice.post_turn(CFG, 'hi', None, opener)
        self.assertTrue(reply['done'])
        self.assertIn('add it in the app', reply['say'])


class HintTests(unittest.TestCase):
    def test_ball_names_come_from_the_function(self):
        sent = {}

        def opener(req, timeout):
            sent.update(body=json.loads(req.data), secret=req.get_header('X-alexa-secret'))
            return FakeResponse(b'{"balls": ["Storm Phaze 6", "Storm Nu Blue", 7]}')

        self.assertEqual(voice.fetch_hints(CFG, opener), ['Storm Phaze 6', 'Storm Nu Blue'])
        self.assertEqual(sent, {'body': {'hints': True}, 'secret': 'pw'})

    def test_no_hints_when_offline(self):
        def opener(req, timeout):
            raise urllib.error.URLError('offline')

        self.assertEqual(voice.fetch_hints(CFG, opener), [])

    def test_prompt_keeps_the_shop_words_last(self):
        prompt = voice.listening_prompt(['Storm Phaze 6', 'Storm Nu Blue'])
        self.assertTrue(prompt.startswith('Balls: Storm Phaze 6, Storm Nu Blue. '))
        self.assertTrue(prompt.endswith(voice.VOCAB))
        self.assertEqual(voice.listening_prompt([]), voice.VOCAB)
        self.assertEqual(voice.listening_prompt([f'Ball {i}' for i in range(100)]).count('Ball '), voice.MAX_HINT_BALLS)


class EndpointerTests(unittest.TestCase):
    def test_stops_after_a_pause_following_speech(self):
        ep = voice.Endpointer(noise=100, silence_seconds=0.4)
        frames = [frame(50)] * 3 + [frame(3000)] * 10 + [frame(50)] * 10
        done_at = next(i for i, f in enumerate(frames) if ep.add(f))
        self.assertTrue(ep.spoke)
        self.assertEqual(done_at, 13 + ep.quiet_frames - 1)
        self.assertEqual(len(ep.audio()), (done_at + 1) * voice.FRAME)

    def test_gives_up_when_nobody_talks(self):
        ep = voice.Endpointer(noise=100, wait_seconds=1)
        steps = 0
        while not ep.add(frame(50)):
            steps += 1
        self.assertFalse(ep.spoke)
        self.assertEqual(steps + 1, ep.wait_frames)

    def test_threshold_rises_with_shop_noise(self):
        self.assertEqual(voice.Endpointer(noise=0).threshold, 120)
        self.assertEqual(voice.Endpointer(noise=1000).threshold, 2000)
        # A lathe at 1000 doesn't count as talking.
        ep = voice.Endpointer(noise=1000)
        ep.add(frame(1000))
        self.assertFalse(ep.spoke)

    def test_long_talking_is_cut_off(self):
        ep = voice.Endpointer(noise=0, max_seconds=1)
        steps = 1
        while not ep.add(frame(3000)):
            steps += 1
        self.assertEqual(steps, ep.max_frames)


class ConversationTests(unittest.TestCase):
    def run_conversation(self, heard, replies):
        shop = voice.Shop.__new__(voice.Shop)
        shop.cfg, shop.sd = CFG, None
        heard, replies, said, posted = list(heard), list(replies), [], []
        shop.listen = lambda: heard.pop(0)
        shop.say = said.append
        shop.flush = lambda: None
        original_post, original_beep = voice.post_turn, voice.beep
        voice.post_turn = lambda cfg, text, state, resume=False: posted.append((text, state)) or replies.pop(0)
        voice.beep = lambda sd, *a: None
        try:
            shop.conversation()
        finally:
            voice.post_turn, voice.beep = original_post, original_beep
        return said, posted

    def test_follow_up_questions_carry_state(self):
        said, posted = self.run_conversation(
            ['work order for Doug Smith', 'plug his 14 pound ball'],
            [{'done': False, 'say': 'What are we doing for Doug Smith?', 'state': 's1'},
             {'done': True, 'say': 'Work order added for Doug Smith: Plug 14 lb ball.'}])
        self.assertEqual(posted, [('work order for Doug Smith', None), ('plug his 14 pound ball', 's1')])
        self.assertEqual(said[-1], 'Work order added for Doug Smith: Plug 14 lb ball.')

    def test_never_mind_stops_without_a_ticket(self):
        said, posted = self.run_conversation(
            ['work order', 'never mind'],
            [{'done': False, 'say': "Who's it for, and what are we doing?", 'state': 's1'}])
        self.assertEqual(len(posted), 1)
        self.assertEqual(said[-1], 'Okay, never mind.')

    def test_a_new_wake_word_soon_after_carries_the_state_on(self):
        shop = voice.Shop.__new__(voice.Shop)
        shop.cfg, shop.sd = CFG, None
        shop.memory = ('old', voice.time.time() - 60)
        heard, sent, said = ['change that one'], [], []
        shop.listen = lambda: heard.pop(0)
        shop.say = said.append
        shop.flush = lambda: None
        original = voice.post_turn
        voice.post_turn = lambda cfg, text, state, resume=False: sent.append((text, state, resume)) or {'done': True, 'say': 'Changed.', 'state': 'new'}
        try:
            shop.conversation()
        finally:
            voice.post_turn = original
        self.assertEqual(sent, [('change that one', 'old', True)])
        self.assertEqual(shop.memory[0], 'new')

        # After five minutes it starts fresh.
        shop.memory = ('old', voice.time.time() - 600)
        heard.append('work order')
        voice.post_turn = lambda cfg, text, state, resume=False: sent.append((text, state, resume)) or {'done': True, 'say': 'Ok.'}
        try:
            shop.conversation()
        finally:
            voice.post_turn = original
        self.assertEqual(sent[-1], ('work order', None, False))

    def test_silence_twice_ends_it(self):
        said, posted = self.run_conversation(['', ''], [])
        self.assertEqual(posted, [])
        self.assertEqual(said, ["I didn't hear anything."])

    def test_one_silence_listens_again(self):
        said, posted = self.run_conversation(
            ['work order', '', 'for Doug Smith to plug his ball'],
            [{'done': False, 'say': "Who's it for?", 'state': 's1'}, {'done': True, 'say': 'Done.'}])
        self.assertEqual(posted, [('work order', None), ('for Doug Smith to plug his ball', 's1')])
        self.assertEqual(said[-1], 'Done.')


class MiscTests(unittest.TestCase):
    def test_cancel_words(self):
        for said in ['Never mind', 'nevermind.', 'cancel that', 'Stop']:
            self.assertTrue(voice.CANCEL.match(said), said)
        for said in ['for Doug Smith', 'stopper for the ball return']:
            self.assertFalse(voice.CANCEL.match(said), said)

    def test_wake_word_is_trimmed_from_what_was_heard(self):
        for said in ['Hey Jarvis, work order for Doug', 'Jarvis. work order for Doug', 'work order for Doug']:
            self.assertEqual(voice.WAKE_WORDS.sub('', said).strip(), 'work order for Doug')

    def test_piper_voice_plays_every_sentence(self):
        class Chunk:
            def __init__(self, n):
                self.audio_int16_array, self.sample_rate = np.ones(n, np.int16), 22050

        played = []
        speaker = voice.PiperSpeaker.__new__(voice.PiperSpeaker)
        speaker.voice = type('V', (), {'synthesize': lambda self, text: [Chunk(3), Chunk(2)]})()
        speaker.sd = type('SD', (), {'play': lambda self, audio, rate, blocking: played.append((len(audio), rate))})()
        speaker('Work order added. Thanks.')
        self.assertEqual(played, [(5, 22050)])

    def test_online_voice_plays_each_sentence_and_falls_back(self):
        played, backup = [], []
        speaker = voice.EdgeSpeaker.__new__(voice.EdgeSpeaker)
        speaker.sd = type('SD', (), {'play': lambda self, audio, rate, blocking: played.append((len(audio), rate))})()
        speaker.fallback = backup.append
        speaker.miniaudio = type('M', (), {'SampleFormat': type('F', (), {'SIGNED16': 2}),
                                           'decode': staticmethod(lambda data, output_format, nchannels: type('S', (), {'samples': [1] * len(data), 'sample_rate': 44100})())})
        speaker.mp3 = lambda text: text.encode()
        speaker('Booked. Tuesday at 7?')
        self.assertEqual((played, backup), ([(7, 44100), (13, 44100)], []))

        def flaky(text):
            if text.startswith('Tuesday'):
                raise OSError('no internet')
            return text.encode()
        speaker.mp3 = flaky
        speaker('Booked. Tuesday at 7? Thanks.')
        self.assertEqual(backup, ['Tuesday at 7? Thanks.'])

    def test_model_setting_is_sent_and_slower_models_wait_longer(self):
        sent = []

        def opener(req, timeout):
            sent.append((json.loads(req.data)['model'], timeout))
            raise OSError('stop here')
        voice.post_turn(CFG, 'hi', None, opener)
        voice.post_turn({**CFG, 'model': 'sonnet'}, 'hi', None, opener)
        self.assertEqual(sent, [('haiku', 40), ('sonnet', 120)])

    def test_keep_alive_reuses_one_connection_and_reconnects(self):
        made = []

        class Conn:
            def __init__(self, host, timeout):
                self.sock, self.calls, self.broken = None, 0, False
                made.append(self)

            def request(self, method, path, body, headers):
                if self.broken:
                    raise ConnectionResetError('server closed it')
                self.calls += 1
                self.status = 401 if b'bad' in body else 200

            def getresponse(self):
                status = self.status
                return type('R', (), {'status': status, 'reason': 'x', 'headers': {}, 'read': lambda s: b'{"ok": true}'})()

            def close(self):
                pass

        keep = voice.KeepAlive(Conn)
        req = lambda body: voice.urllib.request.Request('https://fn.test/functions/v1/x', data=body, method='POST')
        self.assertEqual(json.loads(keep(req(b'{}'), 5).read()), {'ok': True})
        keep(req(b'{}'), 5)
        self.assertEqual((len(made), made[0].calls), (1, 2))
        made[0].broken = True  # the server dropped the idle connection
        keep(req(b'{}'), 5)
        self.assertEqual(len(made), 2)
        with self.assertRaises(voice.urllib.error.HTTPError) as err:
            keep(req(b'bad'), 5)
        self.assertEqual(err.exception.code, 401)

    def test_log_keeps_the_window_and_the_ai_steps(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            old = os.path.join(folder, '2020-01-01.txt')
            Path(old).write_text('old')
            os.utime(old, (0, 0))
            log = voice.DailyLog(folder)
            self.assertFalse(os.path.exists(old))
            window = io.StringIO()
            tee = voice.Tee(window, log)
            tee.write('Heard (1.2s): work order for ')
            tee.write('Doug\nSays: Done.\n')
            voice.LOG = log
            try:
                said, posted = ConversationTests.run_conversation(self, ['hi'], [{'done': True, 'say': 'Hi.', 'trace': ['find_customer {} -> {}']}])
            finally:
                voice.LOG = None
            lines = Path(folder, voice.time.strftime('%Y-%m-%d') + '.txt').read_text().splitlines()
            self.assertEqual(window.getvalue(), 'Heard (1.2s): work order for Doug\nSays: Done.\n')
            self.assertEqual([l[10:] for l in lines], ['Heard (1.2s): work order for Doug', 'Says: Done.', '   AI: find_customer {} -> {}'])

    def test_config_typo_says_where_and_stops(self):
        path = Path(__file__).with_name('voice-config-bad.tmp.json')
        path.write_text('{\n  "password": "abc"\n  "location": "Valley"\n}')
        out = io.StringIO()
        try:
            with self.assertRaises(SystemExit) as stop, contextlib.redirect_stdout(out):
                voice.load_config(str(path))
        finally:
            path.unlink()
        self.assertEqual(stop.exception.code, voice.CONFIG_PROBLEM)
        self.assertIn('typo on line 3', out.getvalue())

    def test_config_file_overrides_defaults(self):
        path = Path(__file__).with_name('voice-config.tmp.json')
        path.write_text(json.dumps({'_help': 'x', 'password': 'abc', 'location': 'South Side'}))
        try:
            cfg = voice.load_config(str(path))
        finally:
            path.unlink()
        self.assertEqual(cfg['password'], 'abc')
        self.assertEqual(cfg['wake_word'], 'hey_jarvis')
        self.assertNotIn('_help', cfg)


if __name__ == '__main__':
    unittest.main()
