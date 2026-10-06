# Workflow metadata

Workflow definitions and versions are tenant-scoped. A version contains metadata records for steps, transitions, triggers, conditions, and actions. The database assigns unique version numbers and permits only one `PUBLISHED` version per workflow. Published versions should be treated as immutable; changes belong in a new draft version.

The tenant-authorized API implements definition GET/POST/PATCH, version GET/POST, and activate/deactivate operations. It stores bounded steps, trigger metadata, typed condition operators, transitions, and allow-listed `NOTIFICATION`/`APPROVAL` action metadata. There is no visual builder, evaluator, or execution worker. Metadata is inert; do not evaluate it as JavaScript, SQL, shell, templates with code execution, or arbitrary server commands.

Audit creation, draft changes, publication, and retirement in the same tenant transaction. Active versions cannot be silently modified; activation retires the prior published version and publishes a draft, while deactivation retires the current version. The current status names are `DRAFT`, `ACTIVE`, `ARCHIVED` for definitions and `DRAFT`, `PUBLISHED`, `RETIRED` for versions; they are not the proposed `TESTING`/`DISABLED` vocabulary.
