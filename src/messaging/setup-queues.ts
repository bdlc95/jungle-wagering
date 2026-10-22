import { SqsTransport } from './sqs.transport';

async function main() {
  const transport = new SqsTransport();
  try {
    await transport.setupQueues();
  } finally {
    transport.onApplicationShutdown();
  }
}

void main();
