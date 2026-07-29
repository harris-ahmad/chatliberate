# Privacy Policy — ChatLiberate

**Last updated:** July 29, 2026

ChatLiberate is an open-source Chrome extension and CLI tool that helps you export your own ChatGPT conversations to your computer.

## Short version

**We do not collect, store, sell, or transmit your personal data.**  
Everything runs locally on your device. There is no ChatLiberate server and no analytics backend.

## What the extension does

When you click Export (or use related features such as Copy or Print):

1. The extension runs only on `chatgpt.com` / `chat.openai.com`.
2. It uses your **existing logged-in ChatGPT browser session** to request your own conversation data from ChatGPT’s APIs.
3. It packages that data into a ZIP (or copies text to your clipboard / opens the print dialog) **on your device**.
4. Files are saved where your browser downloads them — typically your computer’s Downloads folder.

## Data we do not collect

ChatLiberate does **not** collect:

- Names, emails, or other personally identifiable information
- ChatGPT passwords or credentials
- Conversation contents (beyond processing them locally for your export)
- Location, browsing history across other sites, health, or financial data
- Analytics, advertising identifiers, or usage telemetry

We do not operate a cloud service that receives your chats.

## Data handled locally on your device

To perform an export, the extension may temporarily handle on your device:

- Your ChatGPT session token (in memory, only to call ChatGPT’s APIs as you)
- Conversation text, metadata, and attached files you choose to export
- Optional local progress state in `chrome.storage.local` (e.g. which conversation IDs were already downloaded), so a long export can resume — this stays in your browser and is never sent to us

You can clear saved progress from the extension popup.

## Third parties

- **OpenAI / ChatGPT:** Requests go to ChatGPT’s own endpoints so you can download *your* data. That interaction is governed by OpenAI’s policies, not ours.
- **Google / Chrome:** Normal Chrome Web Store and browser behavior may apply; we do not send them your chat contents.
- We do **not** use third-party analytics, ads, or tracking SDKs.

## Permissions (why they exist)

- **Host access to chatgpt.com / chat.openai.com** — only places ChatGPT chats exist; required to fetch your conversations.
- **storage** — local resume state for interrupted exports.
- **activeTab / scripting** — so the popup can trigger export on the ChatGPT tab you have open.

## Children

ChatLiberate is not directed at children under 13, and we do not knowingly collect children’s data (we collect no user data at all).

## Changes

If this policy changes, we will update the “Last updated” date in this file in the public repository.

## Contact

Questions about this policy: open an issue on the project repository:

https://github.com/harris-ahmad/chatliberate

Source code (MIT License): same repository.
