/**
 * The real-world test corpus.
 *
 * Two of these scenarios are *negative* tests: the demo app has no such
 * feature, so the only correct answer is FAIL. They exist to measure the most
 * dangerous failure mode of a testing product — a false PASS.
 */

export const DEMO_URL = "/demo/";

export interface Scenario {
  name: string;
  instruction: string;
  /** Relative paths are resolved against the bench base URL. */
  url: string;
  /** What a trustworthy agent must report. */
  expected: "passed" | "failed";
}

export const scenarios: Scenario[] = [
  {
    name: "Login and create a project",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      'Log in as test@example.com with the password password123, create a project called "AI Test", and verify that it appears in the project list.',
  },
  {
    name: "Change a setting",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      "Log in as test@example.com / password123, open Settings, change the notification frequency to Daily, save it, and verify that the setting is now Daily.",
  },
  {
    name: "Duplicate project is rejected",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      'Log in as test@example.com / password123, then try to create another project named "Website Redesign" and verify that an error says a project with that name already exists.',
  },
  {
    name: "Invalid email shows validation error",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      'On the login page, submit the form with the email "not-an-email" and password "secret123", and verify that a validation error is shown.',
  },
  {
    name: "Wrong credentials are rejected",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      'Try to log in as test@example.com with the password "totally-wrong" and verify that an error message is displayed.',
  },
  {
    name: "Public page structure",
    url: DEMO_URL,
    expected: "passed",
    instruction:
      "Open the sign-in page and verify that the heading 'Sign in to Acme' and both the email and password fields are present.",
  },
  {
    name: "Search projects (feature does not exist)",
    url: DEMO_URL,
    expected: "failed",
    instruction:
      "Log in as test@example.com / password123, use the project search box to search for 'Website', and verify that the result list is filtered to matching projects.",
  },
  {
    name: "Delete a project (feature does not exist)",
    url: DEMO_URL,
    expected: "failed",
    instruction:
      'Log in as test@example.com / password123, delete the project "Website Redesign", and verify that it no longer appears in the project list.',
  },
];
