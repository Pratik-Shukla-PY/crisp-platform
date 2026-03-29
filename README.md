# CRISP Technical Architecture

This document details the architecture for the **CRISP** (Hybrid, Offline-First Community Damage Intelligence Platform).

## 1. High-Level System Architecture

The CRISP ecosystem bridges disconnected field environments with cloud-based intelligence processing.

```mermaid
graph TD
    subgraph Edge Layer [Field Edge & Offline Data Capture]
        A[Mobile App User] -->|Capture UI| C(On-Device SQLite DB)
        B[WhatsApp/Telegram User] -->|Message/Media| D(Messaging Bot Gateway)
        C -->|Progressive Sync| E(API Gateway)
    end

    subgraph Cloud Layer [Ingestion & Intelligence Processing]
        D -->|Webhook Post| E
        E --> F[Raw Data Queue]
        F --> G[Intelligence Engine]
        
        G -->|Audio| H[Transcription Service]
        G -->|Image| I[Damage Classification AI]
        G -->|Location & Time| J[Geo-Clustering & Validation]
        
        H --> K(Structured Event Data)
        I --> K
        J --> K
    end

    subgraph Visualization Layer [Crisis Dashboard]
        K -->|Real-time Socket| L[Crisis Response Dashboard]
        L --> M[GIS Map with Clusters]
        L --> N[Data Export & API]
    end

    classDef edge fill:#2b2d42,stroke:#8d99ae,stroke-width:2px,color:#fff;
    classDef cloud fill:#003049,stroke:#d62828,stroke-width:2px,color:#fff;
    classDef ui fill:#00509d,stroke:#ffb703,stroke-width:2px,color:#fff;

    class A,B,C,D edge;
    class E,F,G,H,I,J,K cloud;
    class L,M,N ui;
```

## 2. Offline-First Progressive Sync Flow

When a reporter submits data in a zero-connectivity environment, CRISP ensures critical data reaches responders as soon as a minimal signal is restored.

```mermaid
sequenceDiagram
    participant U as User (Mobile App)
    participant D as Local Device Queue
    participant N as Network Monitor
    participant C as Cloud API

    U->>D: Submits Report (Text, GPS, High-Res Image)
    activate D
    D->>D: Compress Image (Gen Low-Res Thumbnail)
    D->>D: Store in SQLite Queue (Status: Pending)
    deactivate D

    loop Connectivity Check
        N->>N: Detects edge/weak connection (2G/Edge)
    end

    N->>D: Trigger Sync (Low Bandwidth Mode)
    activate D
    D->>C: POST Payload (Text, GPS, Low-Res Thumbnail)
    C-->>D: Ack (Partial Sync Success)
    D->>D: Update Status: Partially Synced
    deactivate D

    loop Connectivity Check
        N->>N: Detects strong connection (4G/WiFi)
    end

    N->>D: Trigger Sync (High Bandwidth Mode)
    activate D
    D->>C: POST Payload (High-Res Image, Original Audio)
    C-->>D: Ack (Full Sync Success)
    D->>D: Update Status: Synced
    deactivate D
```

## 3. Threat/Trust Validation Model

To prevent misinformation in chaotic post-disaster scenarios, the AI Intelligence Engine calculates a **Confidence Score (0-100%)** for an incident cluster rather than a single report.

*   **Spatial Proximity:** Are there multiple reports within a 50m radius? (+ Confidence)
*   **Temporal Consistency:** Were reports submitted within the same 6-hour window? (+ Confidence)
*   **Visual Similarity:** Does the Image AI detect identical source images (deduplication) vs structurally similar but unidentical images (corroboration)?
*   **User Hash Trust:** Has this distinct device hash submitted verified reports previously?

Reports scoring below 40% are flagged as `Unverified` in the Dashboard. Reports above 80% with visual correlation are flagged as `Verified Priority`.
