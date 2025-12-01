import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Execute a prompt with LLM and return parsed JSON response
 * @param {string} prompt - The prompt to execute
 * @param {string} model - The model to use (default: gpt-5o-mini)
 * @param {string} tag - Tag for cost tracking (logging only)
 * @param {Object} options - Additional options
 * @param {string} options.reasoningEffort - Reasoning effort level for o1 models: 'low', 'medium', 'high' (default: 'medium')
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function ask(prompt, model = DEFAULT_MODEL, tag = 'book-enrich', options = {}) {
  try {
    const requestParams = {
      messages: [{ role: 'user', content: prompt }],
      model: model,
      response_format: {
        type: 'json_object',
      },
    };

    // Add reasoning_effort parameter for o1 models that support it
    if (options.reasoningEffort && (model.includes('o1') || model.includes('o3'))) {
      requestParams.reasoning_effort = options.reasoningEffort;
    }

    const chatCompletion = await openai.chat.completions.create(requestParams);

    const data = JSON.parse(chatCompletion.choices[0].message.content);
    
    // Log comprehensive token usage including reasoning tokens
    const usage = chatCompletion.usage;
    const { 
      prompt_tokens, 
      completion_tokens, 
      total_tokens,
      completion_tokens_details 
    } = usage;

    let logMessage = `[${tag}] ${model}: ${prompt_tokens} prompt + ${completion_tokens} completion`;
    
    // Log reasoning tokens if available (for o1/o3 models)
    if (completion_tokens_details?.reasoning_tokens) {
      logMessage += ` (${completion_tokens_details.reasoning_tokens} reasoning)`;
    }
    
    // Log accepted/rejected prediction tokens if available (for models with prompt caching)
    if (completion_tokens_details?.accepted_prediction_tokens) {
      logMessage += ` [${completion_tokens_details.accepted_prediction_tokens} accepted predictions]`;
    }
    if (completion_tokens_details?.rejected_prediction_tokens) {
      logMessage += ` [${completion_tokens_details.rejected_prediction_tokens} rejected predictions]`;
    }
    
    logMessage += ` = ${total_tokens} total tokens`;
    console.log(logMessage);
    
    return data;
  } catch (error) {
    console.error('Error executing JSON prompt with OpenAI:', error);
    throw new Error('Failed to execute JSON prompt');
  }
}

