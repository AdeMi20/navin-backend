import { jest, describe, expect, beforeAll, afterAll, it } from '@jest/globals';
import { io, Socket } from 'socket.io-client';
import { createServer, Server } from 'http';
import { signToken } from './fixtures/factories.js';
import { randomUUID } from 'crypto';
import { joinShipmentRoom, listenOnEphemeralPort, teardownSocketSuite, waitForSocketEvent } from './helpers/flush.js';

describe('payment_status_changed socket event', () => {
  let httpServer: Server;
  let socketClient: Socket;
  let testPort: number;
  const SHIPMENT_ID = '671000000000000000000099';

  beforeAll(async () => {
    await jest.unstable_mockModule('../src/modules/shipments/shipments.model.js', () => ({
      Shipment: {
        findById: jest.fn(() => ({
          select: jest.fn(() => ({
            lean: jest.fn(() =>
              Promise.resolve({ enterpriseId: 'org456', logisticsId: 'org789' })
            ),
          })),
        })),
      },
      ShipmentStatus: {},
    }));

    httpServer = createServer();
    const { initSocketIO } = await import('../src/infra/socket/io.js');
    initSocketIO(httpServer);

    testPort = await listenOnEphemeralPort(httpServer);

    const token = signToken({ userId: 'user-1', role: 'ADMIN', organizationId: 'org456', jti: randomUUID() });

    socketClient = io(`http://localhost:${testPort}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Socket client did not connect within 10 s')),
        10_000
      );
      socketClient.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socketClient.on('connect_error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }, 30_000);

  afterAll(async () => {
    await teardownSocketSuite({ socketClient, httpServer });
  });

  it('delivers payment_status_changed to joined shipment room clients', async () => {
    await joinShipmentRoom(socketClient, SHIPMENT_ID);

    const eventPromise = waitForSocketEvent<Record<string, unknown>>(
      socketClient,
      'payment_status_changed',
      10_000
    );

    const { emitPaymentStatusChange } = await import('../src/infra/socket/io.js');
    emitPaymentStatusChange(SHIPMENT_ID, {
      paymentId: 'pay-1',
      shipmentId: SHIPMENT_ID,
      oldStatus: 'Pending',
      newStatus: 'Released',
      amount: 250,
      timestamp: '2026-07-24T21:00:00.000Z',
    });

    const payload = await eventPromise;
    expect(payload).toMatchObject({
      paymentId: 'pay-1',
      shipmentId: SHIPMENT_ID,
      oldStatus: 'Pending',
      newStatus: 'Released',
      amount: 250,
    });
  });
});
