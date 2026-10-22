"""Shop voice bot: say "Hey Jarvis", then the work order.

Runs on a spare laptop. The wake word and speech-to-text run on the laptop;
the words go to the alexa-work-order Supabase function (named for the Alexa
skill it first served), which asks follow-up questions, looks up the
customer's phone and adds the ticket. The laptop speaks the answer.

Setup and settings: voice/README.md and voice/config.json.
"""

import json
import os
import queue
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RATE = 16000
FRAME = 1280  # 80 ms, the frame size the wake word model expects
MAX_TURNS = 5

DEFAULTS = {
    "function_url": "https://ngghyuvykqqklztvvmld.supabase.co/functions/v1/alexa-work-order",
    "password": "",
    "location": "Valley",
    "wake_word": "hey_jarvis",
    "wake_threshold": 0.5,
    "whisper_model": "base.en",
    "mic": None,
    "silence_seconds": 1.0,
    "max_seconds": 20,
    "voice": "en_US-lessac-medium",
}

# Biases speech-to-text toward the words the shop actually says.
VOCAB = ("Work order for the bowling pro shop. Plug and redrill, resurface, "
         "thumb slug, finger inserts, 14 pound ball, Storm, Hammer, Roto Grip, "
         "Valley, South Side, league.")

# The tail of the wake word can end up in the recording.
WAKE_WORDS = re.compile(r"^\W*((hey|hi|a)\W+)?(jarvis|mycroft|rhasspy|alexa)\b\W*", re.I)
CANCEL = re.compile(r"^\s*(never ?mind|cancel|stop|forget it|nothing)\b", re.I)


def load_config(path=os.path.join(HERE, "config.json")):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:  # Notepad may add a BOM
            cfg.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
    return cfg


# ---------------------------------------------------------------------------
# Talking to the work order function
# ---------------------------------------------------------------------------

def post_turn(cfg, text, state, opener=urllib.request.urlopen):
    """One turn of the conversation. Returns the function's reply as a dict."""
    body = {"text": text, "location": cfg["location"]}
    if state:
        body["state"] = state
    req = urllib.request.Request(
        cfg["function_url"],
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-alexa-secret": cfg["password"]},
        method="POST",
    )
    try:
        with opener(req, timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            data = json.loads(err.read().decode("utf-8"))
            why = data.get("say") or data.get("error") or ""
        except Exception:
            why = ""
        return {"done": True, "say": why or f"Sorry, the work order server said error {err.code}."}
    except Exception as err:
        print("Server problem:", err)
        return {"done": True, "say": "Sorry, I couldn't reach the work order server. Please add it in the app."}


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def rms(frame):
    return float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))


class Endpointer:
    """Decides when someone has started and finished talking, by loudness.

    The threshold sits well above the room's background noise, which is
    measured from the frames heard while waiting for the wake word.
    """

    def __init__(self, noise, silence_seconds=1.0, max_seconds=20, wait_seconds=6):
        self.threshold = max(noise * 2.0, 120.0)
        self.quiet_frames = int(silence_seconds * RATE / FRAME)
        self.max_frames = int(max_seconds * RATE / FRAME)
        self.wait_frames = int(wait_seconds * RATE / FRAME)
        self.frames = []
        self.spoke = False
        self.quiet = 0
        self.loudest = 0.0

    def add(self, frame):
        """Returns True once the recording is finished."""
        self.frames.append(frame)
        level = rms(frame)
        self.loudest = max(self.loudest, level)
        if level >= self.threshold:
            self.spoke = True
            self.quiet = 0
        else:
            self.quiet += 1
        if not self.spoke:
            return len(self.frames) >= self.wait_frames
        return self.quiet >= self.quiet_frames or len(self.frames) >= self.max_frames

    def audio(self):
        return np.concatenate(self.frames).astype(np.float32) / 32768.0 if self.frames else np.zeros(0, np.float32)


class PiperSpeaker:
    """A natural-sounding voice (Piper) that runs on the laptop and stays loaded."""

    def __init__(self, sd, name):
        from pathlib import Path
        from piper import PiperVoice
        from piper.download_voices import download_voice

        folder = Path(HERE) / "voices"
        folder.mkdir(exist_ok=True)
        if not (folder / f"{name}.onnx").exists():
            download_voice(name, folder)
        self.sd = sd
        self.voice = PiperVoice.load(folder / f"{name}.onnx")

    def __call__(self, text):
        print("Says:", text)
        chunks = list(self.voice.synthesize(text))
        audio = np.concatenate([c.audio_int16_array for c in chunks])
        self.sd.play(audio, chunks[0].sample_rate, blocking=True)


def speak(text):
    """The computer's built-in voice: robotic, but always there."""
    print("Says:", text)
    try:
        if sys.platform == "win32":
            script = ("Add-Type -AssemblyName System.Speech; "
                      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())")
            subprocess.run(["powershell", "-NoProfile", "-Command", script],
                           input=text, text=True, check=False,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif sys.platform == "darwin":
            subprocess.run(["say", text], check=False)
        else:
            subprocess.run(["espeak", text], check=False)
    except FileNotFoundError:
        pass


def beep(sd, freq=880, seconds=0.25):
    t = np.arange(int(RATE * seconds)) / RATE
    sd.play((0.6 * np.sin(2 * np.pi * freq * t)).astype(np.float32), RATE, blocking=True)


class Shop:
    def __init__(self, cfg):
        import sounddevice as sd
        from openwakeword.model import Model
        from openwakeword.utils import download_models
        from faster_whisper import WhisperModel

        self.cfg, self.sd = cfg, sd
        print("Loading models (the first run downloads them)...")
        self.speak = speak
        if cfg["voice"]:
            try:
                self.speak = PiperSpeaker(sd, cfg["voice"])
            except Exception as err:
                print("Using the built-in voice; Piper didn't load:", err)
        download_models([cfg["wake_word"]])
        self.wake = Model(wakeword_models=[cfg["wake_word"]], inference_framework="onnx")
        self.whisper = WhisperModel(cfg["whisper_model"], device="cpu", compute_type="int8")
        self.frames = queue.Queue()
        self.noise = []
        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=FRAME,
                                     device=cfg["mic"], callback=self._heard)

    def _heard(self, data, _frames, _time, status):
        self.frames.put(data[:, 0].copy())

    def flush(self):
        """Drop audio heard while the laptop was talking, so it doesn't hear itself."""
        while not self.frames.empty():
            self.frames.get_nowait()
        self.wake.reset()

    def wait_for_wake(self):
        heard = 0
        while True:
            frame = self.frames.get()
            self.noise = (self.noise + [rms(frame)])[-100:]
            heard += 1
            if heard == 50 and max(self.noise) < 1:
                print("The mic is sending silence. Windows: Settings > Privacy > Microphone, "
                      "turn on 'Let desktop apps access your microphone'. Or pick another mic in config.json.")
            scores = self.wake.predict(frame)
            if max(scores.values()) >= self.cfg["wake_threshold"]:
                return

    def mic_check(self, seconds=20):
        """Prints the mic level and wake word score, to see what it hears."""
        name = self.cfg["wake_word"].replace("_", " ").title()
        print(f'Mic check for {seconds} seconds. Talk, and say "{name}" a few times.')
        with self.stream:
            levels, best = [], 0.0
            for i in range(int(seconds * RATE / FRAME)):
                frame = self.frames.get()
                levels.append(rms(frame))
                best = max(best, max(self.wake.predict(frame).values()))
                if len(levels) == 6:
                    level = max(levels)
                    print(f"level {level:6.0f} {'#' * min(60, int(level / 50))}"
                          f"{'   <- Hey Jarvis heard' if best >= self.cfg['wake_threshold'] else ''}"
                          f"   (wake score {best:.2f})")
                    levels, best = [], 0.0
        print("Speech should reach at least 120. Below that, the mic is too quiet: turn up its "
              "volume in Windows Sound settings > Input, or use a USB mic.")

    def listen(self):
        noise = float(np.median(self.noise)) if self.noise else 0.0
        ep = Endpointer(noise, self.cfg["silence_seconds"], self.cfg["max_seconds"])
        print("Listening...")
        while not ep.add(self.frames.get()):
            pass
        if not ep.spoke:
            print(f"Heard nothing loud enough (loudest {ep.loudest:.0f}, needed {ep.threshold:.0f}).")
            return ""
        started = time.time()
        segments, _ = self.whisper.transcribe(ep.audio(), language="en", beam_size=1,
                                              initial_prompt=VOCAB)
        text = WAKE_WORDS.sub("", " ".join(s.text.strip() for s in segments)).strip()
        print(f"Heard ({time.time() - started:.1f}s):", text or "(nothing)")
        return text

    def say(self, text):
        try:
            self.speak(text)
        except Exception as err:
            print("Voice problem:", err)
            speak(text)
        self.flush()

    def conversation(self):
        state = None
        for _ in range(MAX_TURNS):
            text = self.listen()
            if not text or CANCEL.match(text):
                self.say("Okay, never mind." if text else "I didn't hear anything.")
                return
            started = time.time()
            reply = post_turn(self.cfg, text, state)
            print(f"Server answered in {time.time() - started:.1f}s")
            if reply.get("done") or not reply.get("state"):
                self.say(reply.get("say") or "Done.")
                return
            state = reply["state"]
            self.say(reply["say"])
            beep(self.sd)
            self.flush()

    def run(self):
        name = self.cfg["wake_word"].replace("_", " ").title()
        with self.stream:
            print("Mic:", self.sd.query_devices(self.cfg["mic"], "input")["name"])
            print(f'Ready. Say "{name}", then the work order. Ctrl+C to quit.')
            while True:
                self.wait_for_wake()
                print("Woke up.")
                beep(self.sd)
                # No flush here: words said right after the wake word, without
                # waiting for the beep, are kept.
                self.wake.reset()
                self.conversation()
                self.flush()


def main():
    cfg = load_config()
    if "--list-mics" in sys.argv:
        import sounddevice as sd
        print(sd.query_devices())
        return
    if not cfg["password"]:
        sys.exit("Put the work order password in voice/config.json first (see voice/README.md).")
    if "--test" in sys.argv:
        # An empty turn only asks the first question, so no ticket is added.
        reply = post_turn(cfg, "", None)
        print("Connected." if reply.get("state") else "Not working:", reply.get("say") or reply.get("error"))
        return
    try:
        if "--mic-check" in sys.argv:
            Shop(cfg).mic_check()
            return
        Shop(cfg).run()
    except KeyboardInterrupt:
        print("Bye.")


if __name__ == "__main__":
    main()
