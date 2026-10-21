import importlib.util
import io
import json
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
        self.assertEqual(sent['body'], {'text': 'for Doug Smith', 'location': 'South Side', 'state': 's1'})
        self.assertEqual(sent['secret'], 'pw')
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
        self.assertEqual(voice.Endpointer(noise=0).threshold, 250)
        self.assertEqual(voice.Endpointer(noise=1000).threshold, 2500)
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
        voice.post_turn = lambda cfg, text, state: posted.append((text, state)) or replies.pop(0)
        voice.beep = lambda sd: None
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

    def test_silence_ends_it(self):
        said, posted = self.run_conversation([''], [])
        self.assertEqual(posted, [])
        self.assertEqual(said, ["I didn't hear anything."])


class MiscTests(unittest.TestCase):
    def test_cancel_words(self):
        for said in ['Never mind', 'nevermind.', 'cancel that', 'Stop']:
            self.assertTrue(voice.CANCEL.match(said), said)
        for said in ['for Doug Smith', 'stopper for the ball return']:
            self.assertFalse(voice.CANCEL.match(said), said)

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
