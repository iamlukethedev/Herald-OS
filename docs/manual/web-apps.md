# Web apps

A web app is a website in a window of its own, with its own icon in Applications and the Dock, and
no browser tabs or address bar around it. Gmail, WhatsApp, Notion or your bank's site behave like
any other app, and closing the browser does not close them.

## Adding one

- **From the catalog:** Settings > Software > Web apps has Basecamp, Google Photos, Google Maps,
  Google Contacts, Zoom, Discord and Grok, and the Gaming group has GeForce NOW and Xbox Cloud
  Gaming.
- **Any site:** Install > Web App… in the Herald OS menu (`Super+M`) asks for a name and an address.
  Or ask Hermes: "make a web app for Notion".
- **From a terminal:**

  ```bash
  herald-os install webapp Notion https://www.notion.so
  herald-os install webapp "My bank" https://bank.example.com https://bank.example.com/icon.png
  ```

  The third address is an icon, and is optional: without it, Herald OS fetches the site's own icon.

Every Herald OS Linux install starts with web apps for HEY, Google Calendar, Google Messages,
WhatsApp, X, YouTube, ChatGPT and GitHub.

## Removing one

Remove > Web App… in the Herald OS menu, or `herald-os remove webapp Notion`.

## Good to know

- A web app is a `.desktop` file in `~/.local/share/applications` (named `hermes-webapp-…`) and its
  icon in `~/.local/share/icons/hermes-webapps`, so it is easy to see what you have.
- Only `http://` and `https://` addresses work.
- Web apps are part of Herald OS Linux. On a Mac, use your browser's own "install as app" or "add to
  Dock".
