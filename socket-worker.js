addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  if (url.pathname === '/ws') {
    const upgradeHeader = event.request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return event.respondWith(new Response('Expected websocket', { status: 426 }));
    }
    
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();
    
    let userId = null;
    let streamId = null;
    
    server.addEventListener('message', async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        
        switch (data.type) {
          case 'userConnected':
            userId = data.userId;
            server.send(JSON.stringify({
              type: 'connected',
              userId: userId,
              timestamp: new Date().toISOString()
            }));
            break;
            
          case 'sendMessage':
            if (data.streamId) {
              broadcastToRoom(data.streamId, {
                type: 'ReciveedMsg',
                fromUserId: userId,
                message: data.message,
                timestamp: Date.now()
              });
            }
            break;
            
          case 'call-Invete':
            forwardToUser(data.to, {
              type: 'call-Invete',
              from: userId,
              id: data.id,
              role: data.role
            });
            break;
            
          case 'accept-Invete':
            forwardToUser(data.to, {
              type: 'accept-Invete',
              from: userId,
              id: data.id,
              role: data.role
            });
            break;
            
          case 'offer':
            forwardToUser(data.to, {
              type: 'offer',
              offer: data.offer,
              from: userId,
              role: data.role
            });
            break;
            
          case 'answer':
            forwardToUser(data.to, {
              type: 'answer',
              answer: data.answer,
              from: userId
            });
            break;
            
          case 'ice-candidate':
            forwardToUser(data.to, {
              type: 'ice-candidate',
              candidate: data.candidate,
              from: userId,
              role: data.role
            });
            break;
            
          case 'end-call':
            forwardToUser(data.to, {
              type: 'end-call',
              from: userId
            });
            break;
            
          case 'StartStreming':
            streamId = data.streamId;
            server.send(JSON.stringify({
              type: 'streamStarted',
              streamId: streamId,
              timestamp: Date.now()
            }));
            break;
            
          case 'joinStream':
            streamId = data.streamId;
            server.send(JSON.stringify({
              type: 'joinedStream',
              streamId: streamId,
              hostId: data.hostId
            }));
            break;
            
          case 'sendGift':
            broadcastToRoom(data.streamId, {
              type: 'gift-received',
              userId: userId,
              gift: data.gift,
              streamId: data.streamId
            });
            break;
            
          case 'kickFromStage':
            broadcastToRoom(data.streamId, {
              type: 'user-kicked',
              targetUserId: data.targetUserId,
              streamId: data.streamId,
              by: userId
            });
            forwardToUser(data.targetUserId, {
              type: 'kicked-from-stage',
              streamId: data.streamId,
              by: userId
            });
            break;
            
          case 'ping':
            server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } catch (err) {
        console.error('Error handling message:', err);
      }
    });
    
    server.addEventListener('close', () => {
      console.log('WebSocket closed');
    });
    
    return event.respondWith(new Response(null, { status: 101, webSocket: client }));
  }
  
  if (url.pathname === '/api/health') {
    return event.respondWith(new Response(JSON.stringify({
      status: 'ok',
      role: 'socket',
      timestamp: new Date().toISOString(),
      message: 'Socket worker is running!',
      websocket: true,
      endpoint: '/ws'
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    }));
  }
  
  return event.respondWith(new Response(JSON.stringify({
    message: 'Socket worker is running!',
    endpoints: ['GET /api/health', 'WebSocket /ws'],
    websocket_url: '/ws'
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  }));
});

function broadcastToRoom(roomId, data) {
  console.log(`Broadcast to room ${roomId}:`, data);
}

function forwardToUser(userId, data) {
  console.log(`Forward to user ${userId}:`, data);
}
