# Architecture

`Conversation -> DurableTask -> checkpoints + workingSet + assetRefs`

Runs remain immutable execution attempts. `DurableTaskService` lives in the orchestrator and owns task metadata plus a private workspace under `OPENCLAWX_DATA_DIR/tasks/<taskId>`. Before a resumed run, the current working set is materialized into the isolated run workspace at `.task/`. After any terminal run, safe files are captured back into the task workspace and a checkpoint is appended.

Uploaded inputs remain temporary for ordinary chat. Only after the request is classified as a durable task does the chat service promote the verified original bytes into `working/source/`. Promotion happens before execution and records the upload id, MIME type, size and hash. This keeps lightweight chat cheap while making a selected task independent from attachment-retention cleanup.

This is intentionally generic: no PPT/video-specific workflow, no application-model coupling and no DAG. Assets remain owned by the asset library; tasks store references only. The API exposes lifecycle operations so desktop, mobile and future channels share one state machine.

Automatic activation uses a conservative deterministic classifier. File-bearing creation/transformation requests and explicit multi-step language qualify; ordinary Q&A does not. Explicit continue language prefers the conversation's latest resumable task.
