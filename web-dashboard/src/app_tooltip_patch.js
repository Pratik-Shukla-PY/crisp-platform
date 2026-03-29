// Inject generic title attributes to specific buttons globally if they lack one
document.querySelectorAll('.time-btn').forEach(btn => btn.setAttribute('title', 'Filter reports by timeframe'));
document.querySelectorAll('.stab').forEach(btn => btn.setAttribute('title', 'Filter reports by status status'));
document.querySelectorAll('.icon-btn').forEach(btn => btn.setAttribute('title', 'Export data'));

function injectTitlesToCards() {
    document.querySelectorAll('.btn-dispatch').forEach(btn => { if(!btn.title) btn.title = "Dispatch Resource / Rescue Team"; });
    document.querySelectorAll('.btn-resolve').forEach(btn => { if(!btn.title) btn.title = "Mark Incident as Resolved"; });
    document.querySelectorAll('.btn-view-map').forEach(btn => { if(!btn.title) btn.title = "View Location on Map"; });
    document.querySelectorAll('.btn-false-alarm').forEach(btn => { if(!btn.title) btn.title = "Mark as False Alarm"; });
    document.querySelectorAll('.btn-reopen').forEach(btn => { if(!btn.title) btn.title = "Reopen Incident Workflow"; });
    document.querySelectorAll('.btn-delete').forEach(btn => { if(!btn.title) btn.title = "Delete Record"; });
}
// We will call this post-render feed.
