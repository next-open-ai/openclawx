"""Convert local office documents to Markdown for OpenClawX knowledge ingest."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from zipfile import ZipFile
from xml.etree import ElementTree


def _usable(text: str) -> bool:
    compact = " ".join(text.split())
    return len(compact) >= 80 and compact.count("\ufffd") / max(1, len(compact)) < 0.02


def _markitdown(source: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(source))
    return str(result.text_content or "").strip()


def _builtin(source: Path) -> str:
    if source.suffix.lower() == ".pdf":
        from pypdf import PdfReader

        pages = []
        for index, page in enumerate(PdfReader(str(source)).pages, start=1):
            text = str(page.extract_text() or "").strip()
            if text:
                pages.append(f"## Page {index}\n\n{text}")
        return "\n\n".join(pages)
    if source.suffix.lower() == ".docx":
        with ZipFile(source) as archive:
            root = ElementTree.fromstring(archive.read("word/document.xml"))
        namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for paragraph in root.iter(f"{namespace}p"):
            text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t")).strip()
            if text:
                paragraphs.append(text)
        return "\n\n".join(paragraphs)
    return ""


def _docling(source: Path) -> str:
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import DocumentConverter, NativePdfFormatOption

    # NativePdfFormatOption is model-free: packaged desktop builds do not pull
    # Torch/layout/OCR models at first use. DOCX keeps Docling's simple backend.
    converter = DocumentConverter(
        format_options={InputFormat.PDF: NativePdfFormatOption()}
    )
    result = converter.convert(str(source))
    return str(result.document.export_to_markdown() or "").strip()


def parse(source: Path) -> dict[str, object]:
    warnings: list[str] = []
    markdown = ""
    parser = "builtin"
    try:
        markdown = _markitdown(source)
        parser = "markitdown"
    except ModuleNotFoundError:
        # The enhanced parser is intentionally absent from the compact base
        # installer, so this is a normal fallback rather than a warning.
        pass
    except Exception as exc:  # provider errors are returned as a concise diagnostic
        warnings.append(f"MarkItDown failed: {exc}")

    if not markdown and source.suffix.lower() in {".pdf", ".docx"}:
        try:
            markdown = _builtin(source)
            parser = "builtin"
        except Exception as exc:
            warnings.append(f"Built-in parser failed: {exc}")

    if source.suffix.lower() in {".pptx", ".ppsx"}:
        if not markdown:
            raise RuntimeError("; ".join(warnings) or "No readable presentation content was found.")
        return {"markdown": markdown, "parser": "markitdown", "warnings": warnings}

    # Optional Docling improves short, empty or visibly corrupted extraction.
    if not _usable(markdown):
        try:
            docling_markdown = _docling(source)
            if _usable(docling_markdown) or not markdown:
                return {"markdown": docling_markdown, "parser": "docling", "warnings": warnings}
        except ModuleNotFoundError:
            # Docling is installed only when the user enables the enhancement.
            pass
        except Exception as exc:
            warnings.append(f"Docling failed: {exc}")

    if not markdown:
        raise RuntimeError("; ".join(warnings) or "No readable document content was found.")
    return {"markdown": markdown, "parser": parser, "warnings": warnings}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: document_parser.py <file>")
    print(json.dumps(parse(Path(sys.argv[1]).resolve()), ensure_ascii=False))


if __name__ == "__main__":
    main()
