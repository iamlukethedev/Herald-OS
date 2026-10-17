# Translating Herald OS

Herald OS can show itself in English, in Brazilian Portuguese (Português (Brasil)) or in Simplified
Chinese (简体中文). So far that covers the
menus Herald builds, the menu bar, the main window's sidebar, the Overview, the command bar, the
notifications panel, Settings' navigation, section titles, General section and Hermes & agents, and
first-run setup on the Herald OS image; the rest of the shell is English until its strings move into
the catalogs. This page says how the strings work, how to translate them, and how
to add a language.

## Where the strings are

| File | Holds |
| --- | --- |
| `apps/desktop/shared/locales/en.ts` | English: the source of every message, and what shows when a language lacks one |
| `apps/desktop/shared/locales/pt-BR.ts` | Brazilian Portuguese, which every Portuguese system tag (`pt-PT`, `pt-AO`) also gets |
| `apps/desktop/shared/locales/zh-CN.ts` | Simplified Chinese |
| `apps/desktop/shared/i18n.ts` | The languages, how one is chosen from the setting and the system, `translate` |

Electron main (the menus it builds) and the renderer use the same catalogs.

## Messages

Each message has a key and English text, sometimes with slots or plural forms:

```ts
'menuBar.battery': 'Battery {percent}%',
'overview.mission.files': { one: '{count} file', other: '{count} files' },
```

- Keep every `{slot}`, spelled as in English, wherever your language puts it. One may go:
  `{device}` ("Mac" or "computer"), where your language says "this computer" without it.
- Plural forms follow the language's own categories: English has `one` and `other`, Chinese only
  `other`. The code chooses by `{count}`.
- A comment above a message in `en.ts` says what a slot holds or what must stay English (the words
  the voice and dictation listen for, a Hermes command such as `/model`, a file or setting name).
  A slot shown in monospace, such as `{variable}` in the API key form, holds that name.
- Product names stay as they are: Herald OS, Hermes, Herald Canvas, Docs, Sheets and Slides.
  Hermes's own terms follow Hermes Desktop's catalogs (`upstream/hermes-agent/apps/desktop/src/i18n/`),
  so Hermes reads the same in both apps.

## Translating

Edit your language's file, then check it from `apps/desktop`:

```bash
npx vitest run shared/locales shared/i18n.test.ts
npx tsc -p tsconfig.json --noEmit
```

The test fails when a key is not in English, a slot is missing or added, a plural category is not
one your language has, a message is empty, or a message is the English copied unchanged; the type
check catches a misspelled key. A message may read as in English only when what it keeps is product
names, slots, or a word your language writes the English way (Wi-Fi, Software), which goes in the
short list for your language in `shared/locales/locales.test.ts`. A message
your file lacks shows in English, never as its key: compare the keys of `en.ts` with yours to find
them. To see the result, run the shell (`npm run dev`), pick the language in Settings > General >
Language, and look over the surfaces above. Screenshots of anything that reads wrong, is cut off or
overflows are welcome in the pull request.

## Moving more of the shell into the catalogs

- Add the English message to `en.ts` first: the keys, and the values each message takes, are typed
  from it. Then add its translations.
- In a component, `const t = useT()` (from `src/store/i18n.ts`) and `t('area.key', { slot: value })`.
  Elsewhere (a store, a notification, a table of labels), use `t` from the same module; the
  component that shows the text calls `useT()`, so it renders again when the language changes.
  Tables hold keys (`TextKey`), not text.
- Dates and numbers: pass `$locale` to `toLocaleDateString` and the like, as `src/lib/format.ts`
  does.
- In main, `translate(menuLanguage(), 'area.key')` (`electron/i18n.ts`) as the menu is built.
- Text Herald sends Hermes on the person's behalf, such as a quick action's prompt, is a message
  too, so Hermes answers in their language.
- Identifiers stay English: command ids and titles (Hermes reads them), voice phrases, and the app
  registry's `name`, which the Dock and commands match on (show `appName(app)`).

## Adding a language

1. In `shared/i18n.ts`, add it to `Language` and `LANGUAGES` (under its own name), teach
   `tagLanguage` which system language tags mean it, and register its catalog in `CATALOGS`.
2. Copy `shared/locales/zh-CN.ts` to `shared/locales/<tag>.ts`, translate it, and add it to
   `shared/locales/locales.test.ts`.
3. Add it to the `language.set` command (`src/commands/system.ts`) and to the search words of the
   Language setting (`LANGUAGE_KEYWORDS` in `GeneralSection.tsx`).

## What Herald does not translate itself

- The macOS app menu (Herald OS, Edit, Window) is Electron's default, whose items Electron names in
  English. The items macOS adds to it, such as Services and the window list, follow the system's
  language, as does Chromium's own text (a form's "Please fill out this field").
- What Hermes writes is in whatever language it writes: it answers in the language you use.
