from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from trace_evolver.config import Settings


class Base(DeclarativeBase):
    pass


class RunRecord(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(default="draft")
    input_path: Mapped[str] = mapped_column(Text)
    output_root: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    finished_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TraceFileRecord(Base):
    __tablename__ = "trace_files"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(index=True)
    trace_id: Mapped[str] = mapped_column(index=True)
    thread_id: Mapped[str] = mapped_column(index=True)
    local_path: Mapped[str] = mapped_column(Text)


class EpisodeRecord(Base):
    __tablename__ = "episodes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(index=True)
    episode_id: Mapped[str] = mapped_column(index=True)
    thread_id: Mapped[str] = mapped_column(index=True)
    payload_json: Mapped[str] = mapped_column(Text)


class FamilyRecord(Base):
    __tablename__ = "families"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(index=True)
    family_id: Mapped[str] = mapped_column(index=True)
    payload_json: Mapped[str] = mapped_column(Text)


class PatchRecord(Base):
    __tablename__ = "patches"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(index=True)
    patch_id: Mapped[str] = mapped_column(index=True)
    family_id: Mapped[str] = mapped_column(index=True)
    target_skill_id: Mapped[str | None] = mapped_column(index=True, nullable=True)
    source_kind: Mapped[str] = mapped_column(Text)
    payload_json: Mapped[str] = mapped_column(Text)


class CandidateRecord(Base):
    __tablename__ = "candidates"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(index=True)
    candidate_id: Mapped[str] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(Text)
    recommendation: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_skill_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    full_bundle_path: Mapped[str] = mapped_column(Text)
    files_changed_json: Mapped[str] = mapped_column(Text)
    source_trace_ids_json: Mapped[str] = mapped_column(Text)
    source_thread_ids_json: Mapped[str] = mapped_column(Text)


class CandidateScoreRecord(Base):
    __tablename__ = "candidate_scores"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    candidate_id: Mapped[str] = mapped_column(index=True)
    scores_json: Mapped[str] = mapped_column(Text)


def create_session_factory(settings: Settings) -> sessionmaker[Session]:
    settings.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{settings.sqlite_path}",
        future=True,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@contextmanager
def session_scope(session_factory: sessionmaker[Session]):
    session = session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
