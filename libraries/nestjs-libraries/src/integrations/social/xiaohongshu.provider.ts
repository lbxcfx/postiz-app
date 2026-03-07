import {
    AuthTokenDetails,
    PostDetails,
    PostResponse,
    SocialProvider,
    GenerateAuthUrlResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import mime from 'mime';

// Xiaohongshu-specific settings DTO
export interface XiaohongshuDto {
    title?: string;
    tags?: string[];
    scheduled_time?: string;
}

// API response types
interface XhsApiResponse<T = any> {
    code: number;
    msg: string | null;
    data: T;
}

interface XhsAccount {
    id: number;
    type: number;
    userName: string;
    filePath: string;
    status: number;
    platform: string;
}

interface XhsLoginSession {
    session_id: string;
    platform: string;
    account_name: string;
}

interface XhsLoginStatus {
    session_id: string;
    status: 'pending' | 'waiting_scan' | 'success' | 'failed';
    platform: string;
    messages: string[];
}

interface MaterialCrawlerLoginStatus {
    has_valid_login?: boolean;
    user_data_dir?: string;
}

const CHINA_SOCIAL_SERVICE_URL = process.env.CHINA_SOCIAL_SERVICE_URL || 'http://localhost:5409';
const MEDIACRAWLER_API_URL = (
    process.env.MEDIACRAWLER_API_URL || 'http://127.0.0.1:8081'
).replace(/\/+$/, '');

@Rules(
    'Xiaohongshu (小红书) supports video and image content with title and tags. Maximum title length is 20 characters. Great for lifestyle, beauty, and shopping content.'
)
export class XiaohongshuProvider extends SocialAbstract implements SocialProvider {
    identifier = 'xiaohongshu';
    name = '小红书';
    isBetweenSteps = false;
    scopes: string[] = [];
    editor = 'normal' as const;

    // Xiaohongshu uses cookie-based auth, not OAuth
    oneTimeToken = true;

    maxLength() {
        return 1000; // Content description length
    }

    /**
     * Generate auth URL - for Xiaohongshu, we initiate a QR code login session
     */
    async generateAuthUrl(): Promise<GenerateAuthUrlResponse> {
        try {
            // Create a unique session ID
            const sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);

            // Initialize login session with the social-auto-upload service
            const response = await fetch(`${CHINA_SOCIAL_SERVICE_URL}/api/v1/login/init`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    platform: 'xiaohongshu',
                    account_name: `xhs_${sessionId}`,
                }),
            });

            const result: XhsApiResponse<XhsLoginSession> = await response.json();

            if (result.code !== 200) {
                throw new Error(result.msg || 'Failed to initialize login');
            }

            // Return a URL that the frontend will handle to show QR code
            return {
                url: `${process.env.FRONTEND_URL}/integrations/social/xiaohongshu?session=${result.data.session_id}`,
                codeVerifier: result.data.session_id,
                state: result.data.session_id,
            };
        } catch (error) {
            console.error('Xiaohongshu generateAuthUrl error:', error);
            throw error;
        }
    }

    /**
     * Authenticate - poll for login status and get account info
     */
    async authenticate(params: {
        code: string;
        codeVerifier: string;
        refresh?: string;
    }): Promise<AuthTokenDetails | string> {
        try {
            const sessionId = params.codeVerifier;

            // Poll for login status
            const statusResponse = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/login/status/${sessionId}`
            );

            const statusResult: XhsApiResponse<XhsLoginStatus> = await statusResponse.json();

            console.log('DEBUG: XHS Status Check:', JSON.stringify(statusResult));

            if (statusResult.code !== 200) {
                return 'Login session not found or expired';
            }

            if (statusResult.data.status !== 'success') {
                return `Login not complete. Status: ${statusResult.data.status}`;
            }

            // Get the newly created account
            const accountsResponse = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts?platform=xiaohongshu`
            );

            const accountsResult: XhsApiResponse<XhsAccount[]> = await accountsResponse.json();

            if (accountsResult.code !== 200 || !accountsResult.data.length) {
                return 'Failed to get account information';
            }

            // Find the account that was just created (most recent)
            const account = accountsResult.data[accountsResult.data.length - 1];

            return {
                id: String(account.id),
                name: account.userName,
                accessToken: `${account.id}:${account.filePath}`,
                refreshToken: `${account.id}:${account.filePath}`,
                expiresIn: 86400 * 7, // 7 days (cookie expiry estimated)
                picture: '',
                username: account.userName,
            };
        } catch (error) {
            console.error('Xiaohongshu authenticate error:', error);
            return 'Authentication failed: ' + (error as Error).message;
        }
    }

    /**
     * Refresh token - for Xiaohongshu, this means checking if cookie is still valid
     */
    async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
        try {
            const accountId = refreshToken.split(':')[0];

            // Validate the account cookie
            const response = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts/${accountId}/validate`,
                { method: 'POST' }
            );

            const result: XhsApiResponse<{ id: number; valid: boolean }> = await response.json();

            if (result.code !== 200 || !result.data.valid) {
                throw new Error('Cookie expired, please re-login');
            }

            // Get account info
            const accountsResponse = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts?platform=xiaohongshu`
            );

            const accountsResult: XhsApiResponse<XhsAccount[]> = await accountsResponse.json();
            const account = accountsResult.data.find(a => String(a.id) === accountId);

            if (!account) {
                throw new Error('Account not found');
            }

            return {
                id: String(account.id),
                name: account.userName,
                accessToken: `${account.id}:${account.filePath}`,
                refreshToken: `${account.id}:${account.filePath}`,
                expiresIn: 86400 * 7,
                picture: '',
                username: account.userName,
            };
        } catch (error) {
            console.error('Xiaohongshu refreshToken error:', error);
            throw error;
        }
    }

    /**
     * Post content to Xiaohongshu - supports both video and image posts
     */
    async post(
        id: string,
        accessToken: string,
        postDetails: PostDetails<XiaohongshuDto>[],
        integration: Integration
    ): Promise<PostResponse[]> {
        const [firstPost] = postDetails;

        // Extract account ID from access token
        const accountId = await this.resolveAccountIdForPublish(
            accessToken.split(':')[0] || id
        );

        // Get video from media
        const video = firstPost.media?.find(m => m.type === 'video');
        const images = firstPost.media?.filter(m => m.type === 'image') || [];

        // Xiaohongshu supports both video and images
        if (!video && images.length === 0) {
            throw new Error('Xiaohongshu requires media attachment (video or image)');
        }

        try {
            // Determine if this is a video or image post
            const isVideoPost = !!video;

            if (isVideoPost) {
                // Video post - upload video and use video publish endpoint
                const uploadedFileName = await this.uploadMediaToChinaService(video!.path);
                const response = await fetch(`${CHINA_SOCIAL_SERVICE_URL}/api/v1/xiaohongshu/publish`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        account_id: accountId,
                        video_url: uploadedFileName,
                        title: firstPost.settings?.title || firstPost.message?.substring(0, 20) || '',
                        tags: firstPost.settings?.tags || [],
                        scheduled_time: firstPost.settings?.scheduled_time,
                    }),
                });

                const result: XhsApiResponse = await response.json();

                if (result.code !== 200) {
                    throw new Error(result.msg || 'Failed to publish video to Xiaohongshu');
                }

                return [
                    {
                        id: firstPost.id,
                        postId: `xhs_video_${Date.now()}`,
                        releaseURL: 'https://creator.xiaohongshu.com/publish/success',
                        status: 'processing',
                    },
                ];
            } else {
                // Image post - upload all images and use image publish endpoint
                const uploadedImages: string[] = [];
                for (const image of images) {
                    const uploadedFileName = await this.uploadMediaToChinaService(image.path);
                    uploadedImages.push(uploadedFileName);
                }

                const response = await fetch(`${CHINA_SOCIAL_SERVICE_URL}/api/v1/xiaohongshu/publish-image`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        account_id: accountId,
                        image_urls: uploadedImages,
                        title: firstPost.settings?.title || firstPost.message?.substring(0, 20) || '',
                        description: firstPost.message || '',
                        tags: firstPost.settings?.tags || [],
                        scheduled_time: firstPost.settings?.scheduled_time,
                    }),
                });

                const result: XhsApiResponse = await response.json();

                if (result.code !== 200) {
                    throw new Error(result.msg || 'Failed to publish image to Xiaohongshu');
                }

                return [
                    {
                        id: firstPost.id,
                        postId: `xhs_image_${Date.now()}`,
                        releaseURL: 'https://creator.xiaohongshu.com/publish/success',
                        status: 'processing',
                    },
                ];
            }
        } catch (error) {
            console.error('Xiaohongshu post error:', error);
            throw error;
        }
    }

    private normalizeAccountId(input: string | number | null | undefined) {
        const accountId = Number(String(input || '').trim());
        return Number.isFinite(accountId) && accountId > 0 ? accountId : 0;
    }

    private async validateAccount(accountId: number): Promise<boolean> {
        if (!accountId) {
            return false;
        }
        try {
            const response = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts/${accountId}/validate`,
                { method: 'POST' }
            );
            if (!response.ok) {
                return false;
            }
            const result: XhsApiResponse<{ id: number; valid: boolean }> =
                await response.json();
            if (result?.code !== 200 || typeof result?.data?.valid !== 'boolean') {
                return false;
            }
            return result.data.valid;
        } catch {
            return false;
        }
    }

    private async fetchXhsAccounts(): Promise<XhsAccount[]> {
        try {
            const response = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts?platform=xiaohongshu`
            );
            if (!response.ok) {
                return [];
            }
            const result: XhsApiResponse<XhsAccount[]> = await response.json();
            return Array.isArray(result?.data) ? result.data : [];
        } catch {
            return [];
        }
    }

    private rankAccounts(accounts: XhsAccount[]) {
        return (accounts || [])
            .filter((account) => account?.id && account?.filePath)
            .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    }

    private isUserDataDirAccount(account?: XhsAccount | null) {
        const value = String(account?.filePath || '').trim();
        return value.startsWith('user_data_dir::');
    }

    private async importAccountFromMaterialsLogin(): Promise<number> {
        try {
            const statusResponse = await fetch(
                `${MEDIACRAWLER_API_URL}/api/crawler/login-status/xhs`,
                { method: 'GET' }
            );
            if (!statusResponse.ok) {
                return 0;
            }
            const statusResult = (await statusResponse.json()) as MaterialCrawlerLoginStatus;
            const userDataDir = String(statusResult?.user_data_dir || '').trim();
            if (!statusResult?.has_valid_login || !userDataDir) {
                return 0;
            }

            const importResponse = await fetch(
                `${CHINA_SOCIAL_SERVICE_URL}/api/v1/accounts/import-user-data`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        platform: 'xiaohongshu',
                        user_data_dir: userDataDir,
                        account_name: `materials_xhs_${Date.now().toString(36)}`,
                    }),
                }
            );
            if (!importResponse.ok) {
                return 0;
            }
            const importResult = (await importResponse.json()) as XhsApiResponse<{
                id?: number;
            }>;
            return this.normalizeAccountId(importResult?.data?.id);
        } catch {
            return 0;
        }
    }

    private async resolveAccountIdForPublish(inputAccountId: string) {
        const preferredAccountId = this.normalizeAccountId(inputAccountId);
        const rankedAccounts = this.rankAccounts(await this.fetchXhsAccounts());
        const preferredAccount = rankedAccounts.find(
            (account) => this.normalizeAccountId(account.id) === preferredAccountId
        );

        if (preferredAccountId) {
            const preferredValid = await this.validateAccount(preferredAccountId);
            if (preferredValid === true) {
                return preferredAccountId;
            }
            if (this.isUserDataDirAccount(preferredAccount)) {
                // Shared materials login can still publish through API fallback
                // even when creator page validation fails.
                return preferredAccountId;
            }
        }

        const fallbackCandidates = rankedAccounts.slice(0, 5);
        for (const account of fallbackCandidates) {
            const accountId = this.normalizeAccountId(account.id);
            if (!accountId || accountId === preferredAccountId) {
                continue;
            }
            const valid = await this.validateAccount(accountId);
            if (valid === true) {
                return accountId;
            }
        }

        const sharedLoginFallback = fallbackCandidates.find((account) =>
            this.isUserDataDirAccount(account)
        );
        if (sharedLoginFallback?.id) {
            return this.normalizeAccountId(sharedLoginFallback.id);
        }

        const importedAccountId = await this.importAccountFromMaterialsLogin();
        if (importedAccountId) {
            return importedAccountId;
        }

        throw new Error(
            'No available xiaohongshu login source found. Please login in Materials and retry.'
        );
    }

    private async uploadMediaToChinaService(mediaUrl: string): Promise<string> {
        if (!/^https?:\/\//i.test(mediaUrl)) {
            return mediaUrl;
        }

        const mediaResponse = await fetch(mediaUrl);
        if (!mediaResponse.ok) {
            throw new Error(`Failed to fetch media file: ${mediaResponse.status}`);
        }

        const contentType =
            mediaResponse.headers.get('content-type') || 'application/octet-stream';
        const arrayBuffer = await mediaResponse.arrayBuffer();
        const urlFileName = new URL(mediaUrl).pathname.split('/').pop();
        const fallbackExtension = mime.getExtension(contentType) || 'bin';
        const uploadFileName =
            urlFileName && urlFileName.includes('.')
                ? urlFileName
                : `upload.${fallbackExtension}`;

        const form = new FormData();
        const blob = new Blob([arrayBuffer], { type: contentType });
        form.append('file', blob, uploadFileName);

        const uploadResponse = await fetch(
            `${CHINA_SOCIAL_SERVICE_URL}/api/v1/media/upload`,
            {
                method: 'POST',
                body: form,
            }
        );

        let uploadResult: any = null;
        try {
            uploadResult = await uploadResponse.json();
        } catch (error) {
            throw new Error('Invalid response from China social media upload');
        }

        if (!uploadResponse.ok || uploadResult?.code !== 200) {
            const errorMessage =
                uploadResult?.msg || 'Failed to upload media to China social service';
            throw new Error(errorMessage);
        }

        const uploadedFileName = uploadResult?.data?.filename;
        if (!uploadedFileName) {
            throw new Error('Missing filename from China social service');
        }

        return uploadedFileName;
    }
}
