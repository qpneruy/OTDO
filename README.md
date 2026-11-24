# OTDO — Ôn Tập Đề Online

![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwindcss&logoColor=white)
![Python 3](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)
![YAML](https://img.shields.io/badge/Exam_Format-YAML-CB171E?logo=yaml&logoColor=white)
![KaTeX](https://img.shields.io/badge/Math-KaTeX-008080)
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)

## Purpose

OTDO is a local desktop web app for practicing exams and quizzes written in plain `.yaml` files. All exam files and attempt history stay on your machine (`data/` and `localStorage`), with no account or cloud database required.

## UI & Features

- **Subject & Folder Organizer:** Group exams under root Subjects and nested subfolders, manage them via right-click context menu (create, rename, move, delete), filter in the **Pinned** tab, or search across folders.
- **Quiz View:** Supports Multiple Choice (`A/B/C/D`), True/False statements, Short Answer, and grouped reading/cloze passages (`type: group`), along with a countdown/stopwatch timer and **Turbo Mode** (instant right/wrong feedback upon selection).
- **YAML Exam Editor:** 3-panel mode switcher (**Edit**, **Scoring**, **Reorder**) with live preview supporting Markdown and LaTeX math (KaTeX).
- **Profile & Statistics:** Tracks per-subject GPA, yearly heatmap and weekly activity calendar, plus an attempt history table to review, retry, or delete individual or filtered attempts.
- **Local MCP Server (Optional):** Includes `mcp_server.py` to create, edit, or organize exams directly from an AI assistant.

## Running Locally

On Windows, run `OTDO.bat`, or start the local server from the project root:

```bash
python server.py --open
```

The app opens at `http://127.0.0.1:8765/`. Your personal `data/` directory is excluded via `.gitignore`.

## License

Licensed under the [GNU General Public License v3.0](./LICENSE).
