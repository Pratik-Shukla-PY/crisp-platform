import sqlite3
import uuid
import time
from datetime import datetime

db_path = "crisp_local.db"
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 1. Ensure tables exist (just in case)
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='reports';")
if not cur.fetchone():
    print("Tables not present, skip seeding.")
    conn.close()
    exit()

# 2. Add a test device
device_id = str(uuid.uuid4())
device_hash = "seed-device-123"
cur.execute("INSERT OR IGNORE INTO devices (id, device_hash, platform) VALUES (?, ?, ?);", (device_id, device_hash, "SEEDER"))

# 3. Add test reports with media
def add_report(infra_type, severity, description):
    rid = str(uuid.uuid4())
    now = datetime.now().isoformat()
    cur.execute("""
        INSERT INTO reports (id, device_id, source, status, sync_status, severity, infrastructure_type, description, server_created_at)
        VALUES (?, ?, 'APP', 'PENDING', 'SYNCED', ?, ?, ?, ?);
    """, (rid, device_id, severity, infra_type, description, now))
    
    # Add location
    cur.execute("""
        INSERT INTO locations (id, report_id, latitude, longitude, created_at)
        VALUES (?, ?, ?, ?, ?);
    """, (str(uuid.uuid4()), rid, 20.0 + (time.time() % 1), 0.0 + (time.time() % 1), now))
    
    # Add media (optional dummy)
    cur.execute("""
        INSERT INTO media (id, report_id, type, resolution_tier, url, is_synced, created_at)
        VALUES (?, ?, 'IMAGE', 'LOW', '/static/seed_img.jpg', 1, ?);
    """, (str(uuid.uuid4()), rid, now))

    # Add AI analysis
    cur.execute("""
        INSERT INTO ai_analysis (id, report_id, damage_score, transcription, created_at)
        VALUES (?, ?, 0.8, 'This is a seeded transcription for testing triage.', ?);
    """, (str(uuid.uuid4()), rid, now))

add_report("ROAD", "SEVERE", "Bridge collapse near Sector 7. Immediate attention needed.")
add_report("HOSPITAL", "CRITICAL", "Power failure in emergency ward. Critical medical assets at risk.")
add_report("WATER", "MODERATE", "Major pipe burst on High Street. Multiple residential areas affected.")
add_report("HOUSE", "MINOR", "Minor structural damage reported in suburbia.")

conn.commit()
conn.close()
print("Success: Seeded 4 interactive reports.")
