import "../style.css";
import { Store, type Problem } from "./store";

const views = {
  list: getElement<HTMLElement>("view-list"),
  add: getElement<HTMLElement>("view-add"),
  problem: getElement<HTMLElement>("view-problem"),
};
const frame = getElement<HTMLIFrameElement>("frame");
const form = getElement<HTMLFormElement>("add-form");
const htmlBox = getElement<HTMLTextAreaElement>("html");
const errorMessage = getElement<HTMLElement>("error");
const fileStatus = getElement<HTMLElement>("file-status");

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

function showView(name: keyof typeof views): void {
  for (const [viewName, view] of Object.entries(views)) {
    view.hidden = viewName !== name;
  }

  // Removing srcdoc stops any running animation when leaving the viewer.
  if (name !== "problem") frame.srcdoc = "";
}

function route(): void {
  const hash = window.location.hash || "#/";

  if (hash === "#/add") {
    showView("add");
    return;
  }

  if (hash.startsWith("#/problem/")) {
    let id: string;
    try {
      id = decodeURIComponent(hash.slice("#/problem/".length));
    } catch {
      window.location.hash = "#/";
      return;
    }
    openProblem(id);
    return;
  }

  renderCollection();
  showView("list");
}

function renderCollection(): void {
  const list = getElement<HTMLUListElement>("list");
  const problems = Store.all();
  list.replaceChildren();
  getElement<HTMLElement>("empty").hidden = problems.length > 0;

  for (const problem of problems) {
    const card = document.createElement("li");
    card.className = "problem-card";

    const link = document.createElement("a");
    link.className = "problem-link";
    link.href = `#/problem/${encodeURIComponent(problem.id)}`;

    const title = document.createElement("h2");
    title.textContent = problem.title;
    link.appendChild(title);

    if (problem.description) {
      const description = document.createElement("p");
      description.textContent = problem.description;
      link.appendChild(description);
    }

    const removeButton = document.createElement("button");
    removeButton.className = "remove-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${problem.title}`);
    removeButton.addEventListener("click", () => {
      if (!window.confirm(`Remove “${problem.title}” from your collection?`)) return;
      try {
        Store.remove(problem.id);
        renderCollection();
      } catch {
        window.alert("Could not update browser storage. The problem was not removed.");
      }
    });

    card.append(link, removeButton);
    list.appendChild(card);
  }
}

function openProblem(id: string): void {
  const problem = Store.get(id);
  if (!problem) {
    window.location.hash = "#/";
    return;
  }

  getElement<HTMLElement>("problem-title").textContent = problem.title;
  showView("problem");
  // srcdoc executes the saved document inside the sandboxed iframe.
  frame.srcdoc = problem.html;
}

function createId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function addBundledAnimation(): Promise<void> {
  const id = "lc-pattern-sheet";
  if (Store.get(id)) return;

  try {
    const response = await fetch("./lc-patterns-30.html");
    if (!response.ok) return;
    const html = await response.text();
    if (!html.trim() || Store.get(id)) return;

    const problem: Problem = {
      id,
      title: "LC Pattern Sheet",
      description: "Interactive sheet of 30 LeetCode patterns.",
      html,
    };
    Store.add(problem);
  } catch {
    // The app remains usable if the bundled example cannot be loaded.
  }
}

getElement<HTMLInputElement>("file").addEventListener("change", async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  if (!/\.html?$/i.test(file.name)) {
    errorMessage.textContent = "Choose an .html or .htm file.";
    input.value = "";
    return;
  }

  try {
    htmlBox.value = await file.text();
    fileStatus.textContent = `Loaded ${file.name}. You can still edit the HTML below.`;
    errorMessage.textContent = "";
  } catch {
    errorMessage.textContent = "Could not read that file. Try pasting its HTML instead.";
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorMessage.textContent = "";

  const title = getElement<HTMLInputElement>("title").value.trim();
  const html = htmlBox.value.trim();
  if (!title || !html) {
    errorMessage.textContent = title
      ? "Upload an HTML file or paste its contents."
      : "Enter a title for this problem.";
    return;
  }

  const problem: Problem = {
    id: createId(),
    title,
    description: getElement<HTMLInputElement>("description").value.trim(),
    html,
  };

  try {
    Store.add(problem);
  } catch {
    errorMessage.textContent = "Could not save. Browser storage may be full; try a smaller HTML file.";
    return;
  }

  form.reset();
  fileStatus.textContent = "Uploading a file fills the code box below.";
  window.location.hash = "#/";
});

window.addEventListener("hashchange", route);

void addBundledAnimation().then(route);

