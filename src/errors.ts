/**
 * Thrown when an attribute filter is requested but the configured database / FTS strategy cannot
 * apply it inside every search leg. Failing closed (instead of silently ignoring the filter)
 * prevents a search from returning rows the caller explicitly excluded.
 */
export class AttributeFiltersUnsupportedError extends Error {
  constructor(
    message = "Attribute filters are not supported by the configured database/FTS strategy",
  ) {
    super(message);
    this.name = "AttributeFiltersUnsupportedError";
  }
}
