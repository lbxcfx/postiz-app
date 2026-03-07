import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { ApiTags } from '@nestjs/swagger';
import { GeneratorDto } from '@gitroom/nestjs-libraries/dtos/generator/generator.dto';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { AgentGraphService } from '@gitroom/nestjs-libraries/agent/agent.graph.service';
import { Response } from 'express';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

@ApiTags('Posts')
@Controller('/posts')
export class PostsController {
  constructor(
    private _postsService: PostsService,
    private _agentGraphService: AgentGraphService,
    private _shortLinkService: ShortLinkService,
    private _integrationService: IntegrationService
  ) {}

  @Get('/:id/statistics')
  async getStatistics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.getStatistics(org.id, id);
  }

  @Post('/should-shortlink')
  async shouldShortlink(@Body() body: { messages: string[] }) {
    return { ask: this._shortLinkService.askShortLinkedin(body.messages) };
  }

  @Post('/:id/comments')
  async createComment(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: { comment: string }
  ) {
    return this._postsService.createComment(org.id, user.id, id, body.comment);
  }

  @Get('/tags')
  async getTags(@GetOrgFromRequest() org: Organization) {
    return { tags: await this._postsService.getTags(org.id) };
  }

  @Post('/tags')
  async createTag(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateTagDto
  ) {
    return this._postsService.createTag(org.id, body);
  }

  @Put('/tags/:id')
  async editTag(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateTagDto,
    @Param('id') id: string
  ) {
    return this._postsService.editTag(id, org.id, body);
  }

  @Get('/')
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsDto
  ) {
    const posts = await this._postsService.getPosts(org.id, query);

    return {
      posts,
    };
  }

  @Get('/find-slot')
  async findSlot(@GetOrgFromRequest() org: Organization) {
    return { date: await this._postsService.findFreeDateTime(org.id) };
  }

  @Get('/find-slot/:id')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id?: string
  ) {
    return { date: await this._postsService.findFreeDateTime(org.id, id) };
  }

  @Get('/old')
  oldPosts(
    @GetOrgFromRequest() org: Organization,
    @Query('date') date: string
  ) {
    return this._postsService.getOldPosts(org.id, date);
  }

  @Get('/group/:group')
  getPostsByGroup(@GetOrgFromRequest() org: Organization, @Param('group') group: string) {
    return this._postsService.getPostsByGroup(org.id, group);
  }

  @Get('/:id')
  getPost(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._postsService.getPost(org.id, id);
  }

  @Post('/')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @Body() rawBody: any
  ) {
    const preparedBody = await this.applyDefaultXhsIntegration(org.id, rawBody);
    const body = await this._postsService.mapTypeToPost(preparedBody, org.id);
    return this._postsService.createPost(org.id, body);
  }

  @Post('/generator/draft')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  generatePostsDraft(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateGeneratedPostsDto
  ) {
    return this._postsService.generatePostsDraft(org.id, body);
  }

  @Post('/generator')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async generatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: GeneratorDto,
    @Res({ passthrough: false }) res: Response
  ) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    for await (const event of this._agentGraphService.start(org.id, body)) {
      res.write(JSON.stringify(event) + '\n');
    }

    res.end();
  }

  @Delete('/:group')
  deletePost(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string
  ) {
    return this._postsService.deletePost(org.id, group);
  }

  @Put('/:id/date')
  changeDate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('date') date: string
  ) {
    return this._postsService.changeDate(org.id, id, date);
  }

  @Post('/separate-posts')
  async separatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { content: string; len: number }
  ) {
    return this._postsService.separatePosts(body.content, body.len);
  }

  private async applyDefaultXhsIntegration(orgId: string, rawBody: any) {
    if (!rawBody || typeof rawBody !== 'object' || !Array.isArray(rawBody.posts)) {
      return rawBody;
    }

    const integrations = await this._integrationService.getIntegrationsList(orgId);
    const integrationById = new Map(
      integrations.map((item) => [item.id, item.providerIdentifier || ''])
    );

    const hasXhsPost = rawBody.posts.some((post: any) => {
      const integrationId = String(post?.integration?.id || '').trim();
      if (!integrationId) {
        return false;
      }
      return this.isXhsProvider(integrationById.get(integrationId) || '');
    });

    const hasMissingIntegration = rawBody.posts.some(
      (post: any) => !post?.integration?.id
    );

    const hasUnknownIntegration = rawBody.posts.some((post: any) => {
      const integrationId = String(post?.integration?.id || '').trim();
      if (!integrationId) {
        return false;
      }
      return !integrationById.has(integrationId);
    });

    if (!hasMissingIntegration && !hasXhsPost && !hasUnknownIntegration) {
      return rawBody;
    }

    const defaultXhsIntegration =
      await this._integrationService.syncXhsIntegrationFromMaterialsLogin(orgId);

    if (!defaultXhsIntegration?.id) {
      return rawBody;
    }

    return {
      ...rawBody,
      posts: rawBody.posts.map((post: any) => ({
        ...post,
        integration: {
          id: this.resolveIntegrationIdForPost(
            post,
            integrationById,
            defaultXhsIntegration.id
          ),
        },
      })),
    };
  }

  private resolveIntegrationIdForPost(
    post: any,
    integrationById: Map<string, string>,
    defaultXhsIntegrationId: string
  ) {
    const currentId = String(post?.integration?.id || '').trim();
    if (!currentId) {
      return defaultXhsIntegrationId;
    }

    const providerIdentifier = integrationById.get(currentId);
    if (!providerIdentifier) {
      return defaultXhsIntegrationId;
    }

    if (this.isXhsProvider(providerIdentifier)) {
      return defaultXhsIntegrationId;
    }

    return currentId;
  }

  private isXhsProvider(providerIdentifier: string) {
    const id = String(providerIdentifier || '').toLowerCase();
    return id.includes('xiaohongshu') || id === 'xhs';
  }
}
