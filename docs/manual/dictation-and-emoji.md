# Dictation and emoji

Both type straight into the app you are using, whichever it is: a browser, a chat, the Terminal, a
document.

## Dictation

1. Put the cursor where the words should go.
2. Press `Super+Ctrl+X` on Herald OS Linux or `Cmd+Ctrl+X` on a Mac, and speak.
3. Pause, and the words are typed where the cursor is. Pressing the key again, or clicking the
   dictation light in the menu bar, finishes straight away.

Say punctuation and keys as words: "comma", "period", "question mark", "new line", "new paragraph",
"press enter".

Dictation turns speech into text through Hermes's speech-to-text, the same one voice uses, so it
works with whichever speech provider Hermes has (Settings > Voice). It needs the microphone, which a
Mac asks about the first time. It waits while you are in a voice conversation with Hermes. A
recording stops after two minutes of speech.

On Linux the words are typed with `wtype`; on a Mac, through System Events, which needs the
Accessibility permission. When typing is not possible, the words are left on the clipboard to paste.

## Emoji

1. Press `Super+Ctrl+E` on Herald OS Linux or `Cmd+Ctrl+E` on a Mac.
2. Search ("party", "thumbs up"), or pick from the list.
3. Press Return, and the emoji is typed where you were.

`herald-os dictate` and `herald-os emoji` do the same from a script or a key of your own.

## Talking to Hermes instead

Dictation types what you say. To have Hermes do something, press the voice key instead (`Super+V` on
Linux, `Alt+Space` on a Mac) and ask; see [Talking to Hermes](talking-to-hermes.md).
