import sqlite3, shutil, datetime, sys, os

DB = "packages/api-server/data/kanban.db"
APPLY = "--apply" in sys.argv

if APPLY:
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{DB}.bak-dedupe-{stamp}"
    shutil.copy2(DB, backup)
    print(f"backup -> {backup}")

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# 1. Duplicate cards: same board + same title. Keep ONE (prefer a done row,
#    then the most recently updated), delete the rest.
cur.execute("""
    SELECT board_id, title, COUNT(*) n
    FROM agent_tasks GROUP BY board_id, title HAVING n > 1
""")
groups = cur.fetchall()

to_delete = []
for g in groups:
    cur.execute("""
        SELECT id, status, updated_at FROM agent_tasks
        WHERE board_id = ? AND title = ?
        ORDER BY (status = 'done') DESC, updated_at DESC, rowid DESC
    """, (g["board_id"], g["title"]))
    rows = cur.fetchall()
    to_delete.extend(r["id"] for r in rows[1:])

# 2. Stale in-flight cards. No keeper or agent is running, so anything still
#    sitting in a working column is stranded.
cur.execute("SELECT id FROM agent_tasks WHERE status IN ('in_progress','claimed','todo','review')")
stale = [r["id"] for r in cur.fetchall() if r["id"] not in set(to_delete)]

print(f"duplicate groups     : {len(groups)}")
print(f"duplicate rows to del: {len(to_delete)}")
print(f"stranded -> done     : {len(stale)}")
cur.execute("SELECT COUNT(*) c FROM agent_tasks")
print(f"total tasks now      : {cur.fetchone()['c']}")

if not APPLY:
    print("\n(dry run — pass --apply to execute)")
    sys.exit(0)

cur.execute("PRAGMA foreign_keys = ON")
con.execute("BEGIN")
CH = 400
for i in range(0, len(to_delete), CH):
    chunk = to_delete[i:i+CH]
    q = ",".join("?" * len(chunk))
    cur.execute(f"DELETE FROM code_changes WHERE task_id IN ({q})", chunk)
    cur.execute(f"DELETE FROM comments WHERE task_id IN ({q})", chunk)
    cur.execute(f"DELETE FROM agent_tasks WHERE id IN ({q})", chunk)
for i in range(0, len(stale), CH):
    chunk = stale[i:i+CH]
    q = ",".join("?" * len(chunk))
    cur.execute(
        f"UPDATE agent_tasks SET status='done', progress=100, "
        f"completed_at=COALESCE(completed_at, updated_at) WHERE id IN ({q})", chunk)
con.commit()

cur.execute("SELECT COUNT(*) c FROM agent_tasks")
print(f"\ntotal tasks after    : {cur.fetchone()['c']}")
cur.execute("SELECT status, COUNT(*) c FROM agent_tasks GROUP BY status")
for r in cur.fetchall():
    print(f"  {r['status']:<12} {r['c']}")
con.close()
