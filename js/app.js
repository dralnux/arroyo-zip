const bootLines = [
  "PERSONAL OS — TERMINAL EDITION",
  "Copyright (c) 2026",
  "",
  "Initializing virtual CPU ........ OK",
  "Memory test 0000-FFFF .......... OK",
  "Loading terminal interface ...... OK",
  "Network interface ............... ONLINE",
  "",
  "Welcome.",
  "Type HELP for available commands."
];

const boot = document.getElementById("bootText");
const output = document.getElementById("output");
const input = document.getElementById("command");
const terminalWindow = document.getElementById("terminalWindow");
const clock = document.getElementById("clock");

let i = 0;
function typeBoot(){
  if(i < bootLines.length){
    boot.textContent += bootLines[i] + "\n";
    i++;
    setTimeout(typeBoot, 55);
  }
}
typeBoot();

const commands = {
  help: `AVAILABLE COMMANDS
  about      display profile
  imsai      show IMSAI-8080 information
  github     open GitHub
  linkedin   open LinkedIn
  resume     open resume
  contact    display contact information
  clear      clear terminal
  date       display system time`,
  about: `ABOUT
------
Welcome to my personal terminal.

This is a static, GitHub Pages-ready retro-computing portfolio.
Replace this text with your own biography, projects and links.`,
  imsai: `IMSAI-8080
---------
A tribute to the classic 1970s microcomputer.

CPU ........ Intel 8080
CLOCK ...... 2 MHz
MEMORY ..... 64 KB
INTERFACE .. FRONT-PANEL STYLE`,
  contact: `CONTACT
-------
Email: you@example.com
Replace this address in js/app.js before publishing.`,
  date: () => new Date().toString()
};

function runCommand(raw){
  const cmd = raw.trim().toLowerCase();
  if(!cmd) return;
  if(cmd === "clear"){ output.textContent=""; return; }
  if(cmd === "github"){ window.open("https://github.com/", "_blank", "noopener"); return; }
  if(cmd === "linkedin"){ window.open("https://www.linkedin.com/", "_blank", "noopener"); return; }
  if(cmd === "resume"){ output.textContent = "RESUME\\n------\\nPlace your resume PDF in assets/resume.pdf and link it here."; return; }
  const value = commands[cmd];
  output.textContent = value ? (typeof value === "function" ? value() : value) :
    `COMMAND NOT FOUND: ${cmd}\\nType HELP for available commands.`;
}

input.addEventListener("keydown", e => {
  if(e.key === "Enter"){
    const line = input.value;
    output.textContent += `\\n> ${line}\\n`;
    runCommand(line);
    input.value = "";
  }
});

document.querySelectorAll(".dock button").forEach(btn => {
  btn.addEventListener("click", () => {
    input.value = btn.dataset.command;
    runCommand(btn.dataset.command);
    input.value = "";
    input.focus();
  });
});

document.getElementById("minBtn").onclick = () => document.body.classList.toggle("minimized");
document.getElementById("closeBtn").onclick = () => {
  output.textContent = "SESSION CLOSED. Press F5 to restart.";
  input.disabled = true;
};

function updateClock(){
  clock.textContent = new Date().toLocaleString();
}
setInterval(updateClock,1000);
updateClock();
