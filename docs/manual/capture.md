# Screenshots, recording, text and QR codes

Herald OS captures the screen, records it, and reads colours, text and QR codes from it, and Hermes
can look at any of it with you.

## Screenshots

| Action | Herald OS Linux | Command |
| --- | --- | --- |
| A selection | `Print` | `herald-os capture screenshot region` |
| The window in front | `Super+Print` | `herald-os capture screenshot window` |
| The whole screen | `Super+Shift+Print` | `herald-os capture screenshot screen` |

Screenshots are saved in `~/Pictures/Screenshots` on Linux and on the Desktop on a Mac.
`herald-os capture screenshot region --edit` (or `window`, `screen`) opens the screenshot in Markup
straight away to draw on it. The Capture section of
the Herald OS menu (`Super+M`) has the same, or just say "take a screenshot".

## Asking Hermes about the screen

- **Part of the screen:** `Super+Shift+S` (Linux) or `Cmd+Shift+S` (Mac). Drag a rectangle, then
  type your question; the selection goes to Hermes as an image.
- **The window in front:** `Super+Space` (Linux) asks Hermes about the focused window.
- **The whole screen:** `Super+Ctrl+Shift+S` (Linux) hands a screenshot of everything to Hermes.

On a Mac, these need the Screen Recording permission, which macOS asks for the first time.

## Recording the screen

`Super+Alt+Print` starts recording the screen, and pressing it again stops. A light in the menu bar
shows that it is recording; click it to stop. The Herald OS menu's Capture section also records with
the microphone, and with a camera bubble in the corner.

Recordings are saved in `~/Videos/Recordings` on Linux (MP4) and in `~/Movies` on a Mac.

On Linux, `herald-os capture transcode <file> gif` turns a recording into a GIF (or `mp4`, `webm`),
and `herald-os capture share <file>` puts it on the clipboard as a file to paste into a chat or a
folder, and opens LocalSend, when it is installed, to send it to another device nearby.

## Colours, text and QR codes

- **Pick a colour:** `Super+Ctrl+Print` (Linux), or say "pick a colour". Click anywhere; the colour
  is copied as `#rrggbb`.
- **Copy text from the screen:** say "copy the text on screen", or `herald-os capture text`. Select
  the area; the text it reads is copied. On Linux it is read by tesseract on this computer.
- **Read a QR code:** say "read this QR code", or `herald-os capture qr`. Select the code; what it
  says is copied, and nowhere else: QR codes often carry secrets, such as the code behind a 2FA
  setup or a Wi-Fi password. The notification says what kind of thing it was ("2FA setup code
  copied"; for a web link, "Link copied: example.com", so you can see where it points), clipboard
  history leaves it out, and Hermes only learns the contents of ordinary links and text. A link
  that looks personal (a sign-in, reset or invitation link, or one carrying a token) only shows
  where it points, even to Hermes. Pasting works as usual. Select one code at a time: when the
  selection holds several, nothing is copied. If the clipboard cannot keep a secret out of its
  history (on Linux, wl-clipboard before 2.2), that code is not copied either and the notification
  says so; ordinary links and text are still copied. In scripts, `herald-os capture qr --print`
  prints the contents.

On a Mac these use macOS's own eyedropper and text recognition.
