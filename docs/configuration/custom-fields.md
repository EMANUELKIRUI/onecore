# Custom fields

`custom_field_definitions` stores organization-scoped metadata keyed by entity type and field key. It supports text, number, boolean, date, datetime, currency, select, multi-select, and reference types. Validation/options are JSON metadata; `custom_field_values` stores values separately and uses a composite organization/definition foreign key so a value cannot reference another tenant's definition.

`parseCustomFieldValue` performs type-level value parsing. Dynamic resource IDs are not foreign keys to arbitrary business-module tables; the owning module must validate resource ownership, reference access, requiredness, options, and validation metadata. No schema is generated from a custom field and no definition may contain executable expressions or SQL.

The tenant-authorized API implements definition GET/POST/PATCH/DELETE, including defaults, visibility, ordering, status, options, and bounded validation metadata. Mutations require `core.organization.custom_fields.manage`; reads require `core.organization.custom_fields.read`; definition changes are audited. Business-record value APIs and integration with Customers/Products/Employees/Suppliers remain out of scope. Keep RLS enabled and forced, and never log sensitive field values.
