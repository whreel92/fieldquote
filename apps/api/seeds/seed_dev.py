"""Development seed: demo company + 5 clients + 8 jobs across statuses.

Idempotent (fixed UUIDs, upsert-by-delete). NEVER run against production.
Usage: uv run python seeds/seed_dev.py  (uses DATABASE_URL)
"""

import os
import sys
import uuid
from decimal import Decimal

from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Client, Company, CompanyRate, Job, User

COMPANY_ID = uuid.UUID("d0000000-0000-4000-8000-000000000001")
OWNER_ID = uuid.UUID("d0000000-0000-4000-8000-0000000000aa")

CLIENTS = [
    ("Sarah Chen", "480-555-0101", "sarah.chen@example.com", "4112 E Cactus Rd, Phoenix, AZ"),
    ("Bob Martinez", "480-555-0102", "bmartinez@example.com", "788 W Elm St, Scottsdale, AZ"),
    ("Dana Whitfield", "480-555-0103", None, "22 N 40th Pl, Mesa, AZ"),
    ("Priya Patel", "480-555-0104", "priya.p@example.com", "9910 S Rural Rd, Tempe, AZ"),
    ("Mike O'Rourke", None, "mike.orourke@example.com", "313 E Osborn Rd, Phoenix, AZ"),
]

JOBS = [
    ("200A panel upgrade — Chen residence", "panel_upgrade", "lead", 0),
    ("EV charger install, 60ft run", "ev_charger", "estimating", 1),
    ("Troubleshoot tripping AFCI", "service_call", "sent", 2),
    ("Kitchen remodel rough-in", "remodel", "won", 3),
    ("Hot tub circuit + disconnect", "circuits_outlets", "in_progress", 4),
    ("6x recessed lights, living room", "fixtures_fans", "complete", 0),
    ("Generator interlock kit", "generator", "paid", 1),
    ("Ceiling fan swap (no box)", "fixtures_fans", "lost", 2),
]


def main() -> None:
    settings = get_settings()
    if settings.app_env == "production":
        raise SystemExit("Refusing to seed a production environment.")
    engine = create_engine(settings.database_url)
    with Session(engine) as db:
        db.execute(delete(Company).where(Company.id == COMPANY_ID))  # cascades
        company = Company(
            id=COMPANY_ID,
            name="Reel Electric (Demo)",
            trade="electrical",
            license_number="AZ-ROC-000000",
            phone="480-555-0100",
            email="demo@fieldquote.dev",
            address="Scottsdale, AZ",
            timezone="America/Phoenix",
            settings={"rates_confirmed": True, "demo": True},
        )
        owner = User(id=OWNER_ID, company_id=COMPANY_ID, role="owner", name="Demo Owner")
        rates = CompanyRate(
            company_id=COMPANY_ID,
            labor_rate=Decimal(145),
            helper_rate=Decimal(70),
            target_margin_pct=Decimal(50),
            tax_rate_pct=Decimal("8.1"),
            markup_model="margin",
        )
        db.add_all([company, owner, rates])
        db.flush()
        clients = [
            Client(company_id=COMPANY_ID, name=n, phone=p, email=e, address=a)
            for n, p, e, a in CLIENTS
        ]
        db.add_all(clients)
        db.flush()
        db.add_all(
            Job(
                company_id=COMPANY_ID,
                client_id=clients[client_idx].id,
                title=title,
                job_type_code=code,
                status=status,
                address=clients[client_idx].address,
                created_by=OWNER_ID,
            )
            for title, code, status, client_idx in JOBS
        )
        db.commit()
    print(f"Seeded demo company {COMPANY_ID} with {len(CLIENTS)} clients and {len(JOBS)} jobs.")


if __name__ == "__main__":
    main()
