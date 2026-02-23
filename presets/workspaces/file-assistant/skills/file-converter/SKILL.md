---
name: file-converter
description: Converts files between formats (e.g., PDF to text, image OCR, docx to pdf) using system tools available in bash (like pandoc, tesseract, ImageMagick, or pdf2text).
allowed-tools: bash
---

# File Converter Skill

Use this skill to convert a file from one format to another or extract content from files.

## Workflow

1. Identify the source file format and the target format.
2. Determine which system tool is available and best suited for the conversion:
   - For document conversion (Markdown, HTML, Word): `pandoc`
   - For images (resize, format change): `convert` or `magick` (ImageMagick)
   - For PDF text extraction: `pdftotext`
   - For OCR on images: `tesseract`
3. Use the `bash` tool to check if the required tool is installed (e.g., `which pandoc`). If not, inform the user they need to install the dependency.
4. Execute the conversion command via `bash`.
5. Verify the output file exists and has content, then notify the user.
