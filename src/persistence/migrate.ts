import { createOrm } from './orm';

const action = process.argv[2] ?? 'up';
void (async () => {
  const orm = await createOrm();
  try {
    if (action === 'up') {
      await orm.migrator.up();
    } else if (action === 'down') {
      await orm.migrator.down();
    } else {
      throw new Error(`Unsupported migration action: ${action}`);
    }
  } finally {
    await orm.close(true);
  }
})();
