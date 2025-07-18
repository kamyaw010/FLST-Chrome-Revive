// Keyboard shortcuts configuration script

const sobj = document.getElementById("csc") as HTMLButtonElement;
if (sobj) {
  sobj.addEventListener("click", () => {
    chrome.tabs.create({
      url: "chrome://extensions/shortcuts",
      active: true,
    });
  });
}
