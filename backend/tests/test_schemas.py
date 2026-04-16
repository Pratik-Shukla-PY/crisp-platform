"""Unit tests for Pydantic schemas — validation edge cases."""
import pytest
from pydantic import ValidationError

from app.schemas.report import (
    ReportCreate, ReportMetaCreate, MediaChunkPayload,
    LocationBase, ThumbnailPayload,
)
from app.models.report import (
    InfraTypeEnum, SeverityEnum, DamageClassEnum, CrisisTypeEnum,
    SourceEnum, ReportStatusEnum,
)


class TestLocationBase:
    def test_valid_location(self):
        loc = LocationBase(latitude=12.97, longitude=77.59)
        assert loc.latitude == 12.97

    def test_location_with_optionals(self):
        loc = LocationBase(latitude=0, longitude=0, accuracy_meters=50.0, user_location_name="Market")
        assert loc.user_location_name == "Market"


class TestReportMetaCreate:
    def test_valid_meta(self):
        meta = ReportMetaCreate(
            device_hash="DEV-ABC123", client_report_id="r-001",
            source="APP", severity="MODERATE", infrastructure_type="ROAD",
            expected_media=1,
        )
        assert meta.device_hash == "DEV-ABC123"

    def test_max_length_description(self):
        meta = ReportMetaCreate(
            device_hash="DEV-X", client_report_id="r-002",
            description="x" * 5000,  # Max allowed
        )
        assert len(meta.description) == 5000

    def test_over_max_length_description_fails(self):
        with pytest.raises(ValidationError):
            ReportMetaCreate(
                device_hash="DEV-X", client_report_id="r-003",
                description="x" * 5001,
            )

    def test_undp_fields_optional(self):
        meta = ReportMetaCreate(device_hash="DEV-X", client_report_id="r-004")
        assert meta.crisis_type is None
        assert meta.damage_classification is None
        assert meta.infrastructure_name is None
        assert meta.debris_clearing_needed is None
        assert meta.service_status is None

    def test_undp_fields_populated(self):
        meta = ReportMetaCreate(
            device_hash="DEV-X", client_report_id="r-005",
            crisis_type="FLOOD", damage_classification="PARTIAL",
            infrastructure_name="City Hospital",
            debris_clearing_needed=True,
            service_status={"electricity": "DISRUPTED"},
        )
        assert meta.crisis_type == "FLOOD"
        assert meta.debris_clearing_needed is True


class TestMediaChunkPayload:
    def test_valid_chunk(self):
        chunk = MediaChunkPayload(
            media_id="m-001", type="IMAGE", seq_num=0, total_chunks=5, data="abc123",
        )
        assert chunk.seq_num == 0

    def test_negative_seq_fails(self):
        with pytest.raises(ValidationError):
            MediaChunkPayload(media_id="m-001", type="IMAGE", seq_num=-1, total_chunks=1, data="x")

    def test_zero_total_chunks_fails(self):
        with pytest.raises(ValidationError):
            MediaChunkPayload(media_id="m-001", type="IMAGE", seq_num=0, total_chunks=0, data="x")

    def test_oversized_data_fails(self):
        with pytest.raises(ValidationError):
            MediaChunkPayload(media_id="m-001", type="IMAGE", seq_num=0, total_chunks=1, data="x" * 1100000)

    def test_512kb_data_accepted(self):
        chunk = MediaChunkPayload(
            media_id="m-001", type="IMAGE", seq_num=0, total_chunks=1, data="x" * 524288,
        )
        assert len(chunk.data) == 524288


class TestEnums:
    def test_infra_type_has_9_values(self):
        assert len(InfraTypeEnum) == 9
        assert "SCHOOL" in [e.value for e in InfraTypeEnum]
        assert "TELECOM" in [e.value for e in InfraTypeEnum]
        assert "GOVERNMENT" in [e.value for e in InfraTypeEnum]

    def test_damage_class_3_tiers(self):
        assert len(DamageClassEnum) == 3
        assert set(e.value for e in DamageClassEnum) == {"NO_DAMAGE", "PARTIAL", "COMPLETE"}

    def test_crisis_type_9_values(self):
        assert len(CrisisTypeEnum) == 9
        assert "EARTHQUAKE" in [e.value for e in CrisisTypeEnum]
        assert "FLOOD" in [e.value for e in CrisisTypeEnum]

    def test_severity_5_values(self):
        assert len(SeverityEnum) == 5

    def test_source_6_channels(self):
        assert len(SourceEnum) == 6
        channels = {e.value for e in SourceEnum}
        assert channels == {"APP", "ANDROID", "WHATSAPP", "TELEGRAM", "SMS", "IVR"}
