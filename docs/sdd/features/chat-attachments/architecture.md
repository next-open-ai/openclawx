# Chat attachments architecture

`@openclawx/contracts` defines metadata. The renderer uploads originals to the authenticated orchestration API. The API owns `~/.openclawx/chat-attachments/<session>/<attachment>` and parses documents without moving them into any durable library. `@openclawx/orchestrator` persists metadata plus bounded extracted model context on the user turn. Image bytes continue through the existing vision path.

Text and Markdown are decoded directly. HTML/HTM uses a dependency-free bounded extractor that keeps the title and readable body structure while removing scripts, styles and non-content markup. PDF/DOCX use the bundled MarkItDown/Docling parser. Sheets use SheetJS and expose workbook structure plus bounded row previews. PPTX/PPSX reuse the already-shipped lightweight `fflate` ZIP implementation and a bounded OOXML text extractor; slide text, table text and relationship-linked speaker notes are grouped by slide. Query-time selection ranks complete slides, so late slides remain discoverable without sending the entire deck. Audio keeps the existing authorized ASR tool path in this first compatible slice. All parsing and storage limits are enforced again on the server.

Legacy binary PPT, macros, embedded scripts, ActiveX and high-fidelity slide rendering are intentionally outside this first slice. No LibreOffice, PowerPoint automation, Python presentation library or heavyweight conversion runtime is bundled.

Administrators may install an optional `python-pptx` component from Settings. It is downloaded into `OPENCLAWX_DATA_DIR/components/pptx-enhanced/python-packages`, never into the bundled runtime or system Python. A validated marker enables automatic MarkItDown PPTX/PPSX selection. Missing, damaged or failing components always fall back to the built-in `fflate` extractor, so offline use and the base installer remain unchanged.

Deletion is conversation-scoped. Uploads older than 24 hours which were never committed, and committed uploads older than 30 days, are cleanup candidates. Active uploads are never cleanup candidates.
