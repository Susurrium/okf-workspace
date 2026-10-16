def normalize_project_category(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("project_category must be a string")
    category = value.strip()
    if not category:
        return None
    if len(category) > 80 or any(ord(char) < 32 or ord(char) == 127 for char in category):
        raise ValueError("project_category must contain 1-80 characters without control characters")
    return category
