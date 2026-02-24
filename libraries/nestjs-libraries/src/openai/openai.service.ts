import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { shuffle } from 'lodash';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
});

// Qwen client for text generation (via DashScope OpenAI-compatible API)
const qwenClient = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY || 'sk-',
  baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});

const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-max';

const PicturePrompt = z.object({
  prompt: z.string(),
});

const VoicePrompt = z.object({
  voice: z.string(),
});

// Wanx (通义万相) API settings - wan2.6-t2i text-to-image model
const WANX_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const WANX_MODEL = process.env.WANX_MODEL || 'wan2.6-t2i';

// Helper function to delay execution
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to call Wanx API for image generation
async function generateImageWithWanx(prompt: string, size = '1024*1024'): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  console.log('[Wanx] DASHSCOPE_API_KEY status:', apiKey ? `configured (${apiKey.substring(0, 8)}...)` : 'NOT SET');
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured');
  }

  console.log('[Wanx] Generating image with prompt:', prompt.substring(0, 100) + '...');
  console.log('[Wanx] Using model:', WANX_MODEL, 'size:', size);

  // Wanx 2.6 supports specific sizes, map nearest if needed or use default
  // Valid sizes: 1024*1024, 720*1280, 1280*720. 
  // If size passed is invalid, formatted as "W*H", we might need to adjust or trust the caller.
  // The test script used 1280*1280 which worked? No, test script used 1280*1280 but the comment said 1024*1024.
  // Actually test script output shows 1280*1280 in parameters.

  const requestBody = JSON.stringify({
    model: WANX_MODEL,
    input: {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: prompt,
            },
          ],
        },
      ],
    },
    parameters: {
      size: size,
      n: 1,
      prompt_extend: true,
      watermark: false,
    },
  });

  const callWanx = async (enableAsyncHeader: boolean) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (enableAsyncHeader) {
      headers['X-DashScope-Async'] = 'enable';
    }
    return fetch(WANX_API_URL, {
      method: 'POST',
      headers,
      body: requestBody,
    });
  };

  let response = await callWanx(true);
  if (!response.ok) {
    const errorText = await response.text();
    const asyncRejected =
      response.status === 403 &&
      /asynchronous calls|async/i.test(errorText) &&
      /AccessDenied/i.test(errorText);
    console.error('[Wanx] API error response:', errorText);

    if (asyncRejected) {
      console.warn('[Wanx] Async mode is not allowed for this API key, retrying in sync mode...');
      response = await callWanx(false);
      if (!response.ok) {
        const syncErrorText = await response.text();
        console.error('[Wanx] Sync fallback error response:', syncErrorText);
        throw new Error(`Wanx API error (${response.status}): ${syncErrorText}`);
      }
    } else {
      throw new Error(`Wanx API error (${response.status}): ${errorText}`);
    }
  }

  const data = await response.json();

  // Handle Async Task Response
  if (data.output?.task_id) {
    const taskId = data.output.task_id;
    console.log('[Wanx] Task ID:', taskId, '- Starting to poll for result...');

    const WANX_MAX_POLL_ATTEMPTS = 120;
    const WANX_POLL_INTERVAL_MS = 2000;
    const WANX_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';

    for (let attempt = 0; attempt < WANX_MAX_POLL_ATTEMPTS; attempt++) {
      await delay(WANX_POLL_INTERVAL_MS);
      const taskResponse = await fetch(`${WANX_TASK_URL}/${taskId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!taskResponse.ok) continue;

      const taskData = await taskResponse.json();
      const taskStatus = taskData?.output?.task_status;

      if (taskStatus === 'SUCCEEDED') {
        const imageUrl = taskData?.output?.results?.[0]?.url; // WANx 2.1 structure
        // Wanx 2.6 structure might be distinct inside results or choices, let's check
        // Test script output used: data?.output?.choices?.[0]?.message?.content?.[0]?.image || data?.output?.results?.[0]?.url
        // Task result structure usually matches the synchronous response structure under 'output' or 'results'.
        // For wan2.6-t2i async:
        // Let's assume standard Dashscope pattern.

        // Try finding image in common paths
        const foundUrl = taskData?.output?.results?.[0]?.url ||
          taskData?.output?.choices?.[0]?.message?.content?.[0]?.image;

        if (foundUrl) return foundUrl;

        console.log('[Wanx] Succeeded but no URL found:', JSON.stringify(taskData, null, 2));
      } else if (taskStatus === 'FAILED') {
        throw new Error(`Wanx task failed: ${JSON.stringify(taskData.output)}`);
      }
    }
    throw new Error('Wanx task timed out');
  }

  // Handle Synchronous Response (if X-DashScope-Async not honored or returns immediately)
  const imageUrl = data?.output?.choices?.[0]?.message?.content?.[0]?.image ||
    data?.output?.results?.[0]?.url;

  if (!imageUrl) {
    throw new Error('No image URL in response: ' + JSON.stringify(data));
  }

  return imageUrl;
}

// Helper function to convert image URL to base64
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  console.log('[Wanx] Converting image URL to base64:', imageUrl.substring(0, 80) + '...');
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    console.log('[Wanx] Base64 conversion successful, length:', base64.length);
    return base64;
  } catch (error) {
    console.error('[Wanx] Base64 conversion error:', error);
    throw error;
  }
}

@Injectable()
export class OpenaiService {
  async generateImage(prompt: string, isUrl: boolean, isVertical = false) {
    console.log('[Wanx] generateImage called - isUrl:', isUrl, 'isVertical:', isVertical);
    try {
      // Use Wanx (通义万相) for image generation
      // wanx2.1-t2i-turbo 支持的尺寸: 1024*1024, 720*1280, 1280*720
      const size = isVertical ? '720*1280' : '1024*1024';
      const imageUrl = await generateImageWithWanx(prompt, size);
      console.log('[Wanx] Got image URL:', imageUrl.substring(0, 80) + '...');

      if (isUrl) {
        return imageUrl;
      } else {
        // Convert URL to base64 if needed
        return await imageUrlToBase64(imageUrl);
      }
    } catch (error) {
      console.error('[Wanx] generateImage error:', error);
      throw error;
    }
  }

  async generatePromptForPicture(prompt: string) {
    return (
      (
        await qwenClient.chat.completions.create({
          model: QWEN_MODEL,
          messages: [
            {
              role: 'system',
              content: `You are an assistant that take a description and style and generate a prompt that will be used later to generate images, make it a very long and descriptive explanation, and write a lot of things for the renderer like, if it${"\'"} realistic describe the camera`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
        })
      ).choices[0].message.content || ''
    );
  }

  async generateVoiceFromText(prompt: string) {
    return (
      (
        await qwenClient.chat.completions.create({
          model: QWEN_MODEL,
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes a social media post and convert it to a normal human voice, to be later added to a character, when a person talk they don\'t use "-", and sometimes they add pause with "..." to make it sounds more natural, make sure you use a lot of pauses and make it sound like a real person`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
        })
      ).choices[0].message.content || ''
    );
  }

  async generatePosts(content: string) {
    const posts = (
      await Promise.all([
        qwenClient.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a Twitter post from the content without emojis in the following JSON format: { "post": string } put it in an array with one element',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model: QWEN_MODEL,
        }),
        qwenClient.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a thread for social media in the following JSON format: Array<{ "post": string }> without emojis',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model: QWEN_MODEL,
        }),
      ])
    ).flatMap((p) => p.choices);

    return shuffle(
      posts.map((choice) => {
        const { content } = choice.message;
        const start = content?.indexOf('[')!;
        const end = content?.lastIndexOf(']')!;
        try {
          return JSON.parse(
            '[' +
            content
              ?.slice(start + 1, end)
              .replace(/\n/g, ' ')
              .replace(/ {2,}/g, ' ') +
            ']'
          );
        } catch (e) {
          return [];
        }
      })
    );
  }
  async extractWebsiteText(content: string) {
    const websiteContent = await qwenClient.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You take a full website text, and extract only the article content',
        },
        {
          role: 'user',
          content,
        },
      ],
      model: QWEN_MODEL,
    });

    const { content: articleContent } = websiteContent.choices[0].message;

    return this.generatePosts(articleContent!);
  }

  async separatePosts(content: string, len: number) {
    const postsResult = await qwenClient.chat.completions.create({
      model: QWEN_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an assistant that take a social media post and break it to a thread, each post must be minimum ${len - 10} and maximum ${len} characters, keeping the exact wording and break lines, however make sure you split posts based on context. Return a JSON object with format: { "posts": ["post1", "post2", ...] }`,
        },
        {
          role: 'user',
          content: content,
        },
      ],
    });

    let posts: string[] = [];
    try {
      const responseContent = postsResult.choices[0].message.content || '';
      const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        posts = parsed.posts || [];
      }
    } catch (e) {
      posts = [];
    }

    return {
      posts: await Promise.all(
        posts.map(async (post: any) => {
          if (post.length <= len) {
            return post;
          }

          let retries = 4;
          while (retries) {
            try {
              const shrinkResult = await qwenClient.chat.completions.create({
                model: QWEN_MODEL,
                messages: [
                  {
                    role: 'system',
                    content: `You are an assistant that take a social media post and shrink it to be maximum ${len} characters, keeping the exact wording and break lines. Return a JSON object with format: { "post": "shortened post" }`,
                  },
                  {
                    role: 'user',
                    content: post,
                  },
                ],
              });
              const shrinkContent = shrinkResult.choices[0].message.content || '';
              const shrinkMatch = shrinkContent.match(/\{[\s\S]*\}/);
              if (shrinkMatch) {
                const shrinkParsed = JSON.parse(shrinkMatch[0]);
                return shrinkParsed.post || post;
              }
              return post;
            } catch (e) {
              retries--;
            }
          }

          return post;
        })
      ),
    };
  }

  async generateSlidesFromText(text: string) {
    for (let i = 0; i < 3; i++) {
      try {
        const message = `You are an assistant that takes a text and break it into slides, each slide should have an image prompt and voice text to be later used to generate a video and voice, image prompt should capture the essence of the slide and also have a back dark gradient on top, image prompt should not contain text in the picture, generate between 3-5 slides maximum. Return a JSON object with format: { "slides": [{ "imagePrompt": "...", "voiceText": "..." }] }`;
        const result = await qwenClient.chat.completions.create({
          model: QWEN_MODEL,
          messages: [
            {
              role: 'system',
              content: message,
            },
            {
              role: 'user',
              content: text,
            },
          ],
        });
        const responseContent = result.choices[0].message.content || '';
        const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed.slides || [];
        }
      } catch (err) {
        console.log(err);
      }
    }

    return [];
  }
}

// trigger rebuild 20:28:29
