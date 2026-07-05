/** Synthetic ChatGPT export shapes for tests — structure mirrors the real
 * conversations.json (mapping tree, branches from regeneration). */

export function chatgptConversationsFixture(): unknown[] {
  return [
    {
      title: 'STR shopping',
      create_time: 1750000000,
      conversation_id: 'conv-1',
      current_node: 'n4',
      mapping: {
        n0: { id: 'n0', message: null, parent: null, children: ['n1'] },
        n1: {
          id: 'n1',
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'text',
              parts: ["I own a short-term rental in Dartmouth and I'm looking for a second one."],
            },
            create_time: 1750000001,
          },
          parent: 'n0',
          children: ['n2', 'n2b'],
        },
        // n2b is an abandoned branch (regenerated answer) — must be ignored.
        n2b: {
          id: 'n2b',
          message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Old abandoned answer.'] },
          },
          parent: 'n1',
          children: [],
        },
        n2: {
          id: 'n2',
          message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Great, what is your budget?'] },
          },
          parent: 'n1',
          children: ['n3'],
        },
        n3: {
          id: 'n3',
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'text',
              parts: ['My budget is around 600k and it must have wow factor.'],
            },
          },
          parent: 'n2',
          children: ['n4'],
        },
        n4: {
          id: 'n4',
          message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Understood.'] },
          },
          parent: 'n3',
          children: [],
        },
      },
    },
    {
      title: 'Coffee chat',
      create_time: 1750100000,
      conversation_id: 'conv-2',
      current_node: 'm2',
      mapping: {
        m0: { id: 'm0', message: null, parent: null, children: ['m1'] },
        m1: {
          id: 'm1',
          message: {
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['I take my coffee black, remember that.'] },
          },
          parent: 'm0',
          children: ['m2'],
        },
        m2: {
          id: 'm2',
          message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Noted!'] },
          },
          parent: 'm1',
          children: [],
        },
      },
    },
  ];
}

export function claudeConversationsFixture(): unknown[] {
  return [
    {
      uuid: 'c-uuid-1',
      name: 'EMS protocols',
      created_at: '2026-06-01T12:00:00Z',
      chat_messages: [
        { sender: 'human', text: 'I am a paramedic and EMS coordinator in Massachusetts.', created_at: '2026-06-01T12:00:01Z' },
        { sender: 'assistant', text: 'How can I help with protocols?', created_at: '2026-06-01T12:00:05Z' },
      ],
    },
  ];
}
