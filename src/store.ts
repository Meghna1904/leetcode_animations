export interface Problem {
  id: string;
  title: string;
  description: string;
  html: string;
}

const STORAGE_KEY = "dsa-animations";

export const Store = {
  all(): Problem[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(value)) return [];
      return value.filter(isProblem);
    } catch {
      return [];
    }
  },

  get(id: string): Problem | undefined {
    return this.all().find((problem) => problem.id === id);
  },

  add(problem: Problem): void {
    const problems = this.all();
    problems.push(problem);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(problems));
  },

  remove(id: string): void {
    const remaining = this.all().filter((problem) => problem.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
  },
};

function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const problem = value as Partial<Problem>;
  return typeof problem.id === "string" &&
    typeof problem.title === "string" &&
    typeof problem.html === "string";
}
