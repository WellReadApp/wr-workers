import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Execute a prompt with LLM and return parsed JSON response
 * @param {string} prompt - The prompt to execute
 * @param {string} model - The model to use (default: gpt-4o-mini)
 * @param {string} tag - Tag for cost tracking (logging only)
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function ask(prompt, model = DEFAULT_MODEL, tag = 'book-enrich') {
  try {
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: model,
      response_format: {
        type: 'json_object',
      },
    });

    const data = JSON.parse(chatCompletion.choices[0].message.content);
    
    // Log token usage
    const { prompt_tokens, completion_tokens } = chatCompletion.usage;
    console.log(`[${tag}] ${model}: ${prompt_tokens} prompt + ${completion_tokens} completion tokens`);
    
    return data;
  } catch (error) {
    console.error('Error executing JSON prompt with OpenAI:', error);
    throw new Error('Failed to execute JSON prompt');
  }
}

