from app.db.session import SessionLocal, engine
from app.models.report import Base, Report, Device, Location
import uuid

Base.metadata.create_all(bind=engine)
db = SessionLocal()
try:
    device = Device(device_hash="test")
    db.add(device)
    db.commit()
    
    r = Report(device_id=device.id, severity="SEVERE", has_video=True, description_text="test")
    db.add(r)
    db.commit()
    print("DB OK")
except Exception as e:
    import traceback
    traceback.print_exc()
finally:
    db.close()
