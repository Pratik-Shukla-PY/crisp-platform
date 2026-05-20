-- ==========================================================
-- CRISP PostgreSQL Schema
-- ==========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis"; -- Optional, for advanced geo queries

-- ----------------------------------------------------------
-- 1. ENUMS
-- ----------------------------------------------------------
CREATE TYPE source_enum AS ENUM ('APP', 'WHATSAPP', 'TELEGRAM');
CREATE TYPE severity_enum AS ENUM ('MINOR', 'MODERATE', 'SEVERE', 'UNKNOWN');
CREATE TYPE infra_type_enum AS ENUM ('ROAD', 'HOSPITAL', 'HOUSE', 'POWER', 'WATER', 'OTHER');
CREATE TYPE media_type_enum AS ENUM ('IMAGE', 'AUDIO');
-- Phase L (May 2026) — canonical 3-value taxonomy. Pre-L vocabulary
-- was LOW/MEDIUM/HIGH/ORIGINAL; alembic 0035 backfilled LOW→SMALL +
-- HIGH→ORIGINAL, 0036 dropped LOW/HIGH from the enum.
CREATE TYPE resolution_enum AS ENUM ('SMALL', 'MEDIUM', 'ORIGINAL');
CREATE TYPE sync_status_enum AS ENUM ('PARTIAL', 'QUEUED', 'SYNCED', 'FAILED');
CREATE TYPE report_status_enum AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE cluster_status_enum AS ENUM ('ACTIVE', 'RESOLVED', 'FALSE_ALARM');

-- ----------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------

-- Devices
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_hash VARCHAR(255) NOT NULL UNIQUE,
    platform VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reports
CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    source source_enum NOT NULL DEFAULT 'APP',
    status report_status_enum NOT NULL DEFAULT 'PENDING',
    sync_status sync_status_enum NOT NULL DEFAULT 'QUEUED',
    severity severity_enum NOT NULL DEFAULT 'UNKNOWN',
    infrastructure_type infra_type_enum NOT NULL DEFAULT 'OTHER',
    description TEXT,
    client_created_at TIMESTAMP WITH TIME ZONE,
    server_created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Locations
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy_meters FLOAT,
    is_user_corrected BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Media (Progressive Uploads)
CREATE TABLE media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
    type media_type_enum NOT NULL,
    resolution_tier resolution_enum NOT NULL DEFAULT 'SMALL',
    url TEXT NOT NULL,
    file_size_bytes BIGINT,
    is_synced BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- AI Analysis (Intelligence Layer)
CREATE TABLE ai_analysis (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
    damage_score FLOAT CHECK (damage_score >= 0.0 AND damage_score <= 1.0),
    ai_severity severity_enum,
    transcription TEXT,
    detected_labels JSONB DEFAULT '[]'::jsonb,
    processing_time_ms INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Incident Clusters (Geo-Clustering)
CREATE TABLE incident_clusters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    radius_meters FLOAT NOT NULL DEFAULT 50.0,
    confidence_score FLOAT CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0) DEFAULT 0.0,
    status cluster_status_enum NOT NULL DEFAULT 'ACTIVE',
    primary_infrastructure_type infra_type_enum,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cluster-Report Mapping
CREATE TABLE cluster_reports (
    cluster_id UUID REFERENCES incident_clusters(id) ON DELETE CASCADE,
    report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (cluster_id, report_id)
);

-- Sync Logs (Tracking connection retry logic)
CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    synced_report_count INT DEFAULT 0,
    last_sync_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status sync_status_enum NOT NULL
);

-- Exports
CREATE TABLE exports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requested_by VARCHAR(255),
    export_format VARCHAR(10) NOT NULL, -- CSV, GEOJSON
    file_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 3. INDEXES
-- ----------------------------------------------------------
CREATE INDEX idx_locations_lat_lng ON locations (latitude, longitude);
CREATE INDEX idx_reports_device ON reports (device_id);
CREATE INDEX idx_reports_status ON reports (status);
CREATE INDEX idx_media_report ON media (report_id);
CREATE INDEX idx_cluster_geo ON incident_clusters (center_lat, center_lng);
