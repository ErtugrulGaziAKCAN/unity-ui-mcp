#!/usr/bin/env tsx
const usage = `Usage: design-export <command> [options]

Commands:
  lint      Lint a Claude Design HTML screen
  export    Export a screen to the intermediate representation
  compare   Compare a Unity capture against the golden

Options:
  --help    Show this help
`;

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  process.stdout.write(usage);
  process.exit(0);
}
process.stderr.write(usage);
process.exit(2);
