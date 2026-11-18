# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe what you found, how to reproduce it and what you think the impact is.

We aim to acknowledge a report within a week, and to tell you what we plan to do about it within a month. This is a volunteer-run project, so these are goals, not guarantees.

## What matters most here

EEG Workbench runs entirely in the browser and has no server, accounts or analytics, so recordings are never uploaded. The areas where a flaw would matter most are:

- **Reading files.** A crafted recording that executes code, corrupts memory or leaks data when it is opened.
- **Cross-site scripting.** Any path where file contents, channel names or annotations end up as executable HTML or script in the page.
- **The service worker** (`public/sw.js`), which caches the analysis engine's downloads: anything that could make it serve tampered content.
- **Supply chain.** The page loads open-source Python packages through Pyodide, and the build depends on npm packages.
- **Anything that sends recording data off the user's machine**, since that would break the project's central privacy promise.

## Supported versions

Only the latest release, and the version currently deployed from the `main` branch, receive fixes.

## Medical use

EEG Workbench is for research and education and is not a medical device. A result that is wrong or misleading is a bug worth reporting, but it is a bug report rather than a security report unless it can be triggered by a malicious file.
