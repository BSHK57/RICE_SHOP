"""
auth/queries.py - ALL SQL for the `app_users` table (users created by the admin from the UI).

No business rules here: validation, hashing and permission handling live in identity.py.
Built-in users (admin / anand / staff) are not in the database at all.
"""
from __future__ import annotations

from app import db

_COLS = "id, username, display_name, password_hash, permissions, is_active, created_at"


def list_users() -> list[dict]:
    return db.query_all(f"SELECT {_COLS} FROM app_users ORDER BY username COLLATE NOCASE")


def get_user_by_id(user_id: int) -> dict | None:
    return db.query_one(f"SELECT {_COLS} FROM app_users WHERE id = ?", (user_id,))


def get_user_by_username(username: str) -> dict | None:
    """Case-insensitive (the column is COLLATE NOCASE)."""
    return db.query_one(f"SELECT {_COLS} FROM app_users WHERE username = ?", (username,))


def insert_user(username: str, display_name: str, password_hash: str, permissions_json: str,
                created_at: str) -> int:
    cur = db.execute(
        "INSERT INTO app_users(username, display_name, password_hash, permissions, is_active, created_at)"
        " VALUES (?,?,?,?,1,?)",
        (username, display_name, password_hash, permissions_json, created_at),
    )
    return cur.lastrowid


def update_user(user_id: int, display_name: str, permissions_json: str, is_active: bool) -> None:
    db.execute(
        "UPDATE app_users SET display_name = ?, permissions = ?, is_active = ? WHERE id = ?",
        (display_name, permissions_json, 1 if is_active else 0, user_id),
    )


def set_password_hash(user_id: int, password_hash: str) -> None:
    db.execute("UPDATE app_users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
