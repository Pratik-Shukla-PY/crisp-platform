// Global audio tracker to ensure only one plays at a time
let currentAudio = null;
window.playAudio = function(url, btnElement) {
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        if (currentAudio.btn) currentAudio.btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (currentAudio.url === url) return; // Toggle logic
    }
    currentAudio = new Audio(url);
    currentAudio.btn = btnElement;
    btnElement.innerHTML = '<i class="fa-solid fa-pause"></i>';
    currentAudio.play();
    currentAudio.onended = () => { btnElement.innerHTML = '<i class="fa-solid fa-play"></i>'; };
    event.stopPropagation();
};

window.playInlineAudio = function(btnElement, url) {
    window.playAudio(url, btnElement);
    if(window.event) window.event.stopPropagation();
};
