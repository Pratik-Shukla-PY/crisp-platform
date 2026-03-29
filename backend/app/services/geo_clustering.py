from sqlalchemy.orm import Session
from uuid import UUID
from typing import Optional
from app.models.report import Report, IncidentCluster, ClusterReport, ClusterStatusEnum
import math

# Simple Haversine implementation for Basic MVP Clustering
def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Radius of earth in meters
    R = 6371e3
    phi1 = lat1 * math.pi / 180
    phi2 = lat2 * math.pi / 180
    delta_phi = (lat2 - lat1) * math.pi / 180
    delta_lambda = (lon2 - lon1) * math.pi / 180

    a = math.sin(delta_phi/2) * math.sin(delta_phi/2) + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda/2) * math.sin(delta_lambda/2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

    return R * c

def cluster_new_report(db: Session, report_id: UUID) -> Optional[IncidentCluster]:
    """
    Structure for real-time geo-clustering of incoming reports.
    Finds the active cluster within 50 meters, or creates a new one.
    """
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report or not report.location:
        return None

    active_clusters = db.query(IncidentCluster).filter(
        IncidentCluster.status == ClusterStatusEnum.ACTIVE
    ).all()

    closest_cluster = None
    min_dist = float('inf')

    # Basic Spatial Query (in Production, PostGIS ST_DWithin is preferred)
    for cluster in active_clusters:
        dist = calculate_distance(
            report.location.latitude, report.location.longitude,
            cluster.center_lat, cluster.center_lng
        )
        if dist <= cluster.radius_meters and dist < min_dist:
            closest_cluster = cluster
            min_dist = dist

    if closest_cluster:
        # Add to existing cluster
        mapping = ClusterReport(cluster_id=closest_cluster.id, report_id=report.id)
        db.add(mapping)
        
        # Increase confidence structurally (up to 1.0)
        closest_cluster.confidence_score = min(1.0, closest_cluster.confidence_score + 0.1)
        db.commit()
        db.refresh(closest_cluster)
        return closest_cluster
    else:
        # Create new cluster
        new_cluster = IncidentCluster(
            center_lat=report.location.latitude,
            center_lng=report.location.longitude,
            radius_meters=50.0,
            confidence_score=0.2, # Start low, needs multiple corroborating reports mapping to increase
            primary_infrastructure_type=report.infrastructure_type
        )
        db.add(new_cluster)
        db.commit()
        db.refresh(new_cluster)
        
        mapping = ClusterReport(cluster_id=new_cluster.id, report_id=report.id)
        db.add(mapping)
        db.commit()
        return new_cluster
