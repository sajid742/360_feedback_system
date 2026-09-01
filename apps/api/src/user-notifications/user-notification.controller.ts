import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { UserNotificationService } from './user-notification.service';

/** Each authenticated user reads and manages only their own notifications, so
 *  this needs authentication but no module permission. */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class UserNotificationController {
  constructor(private readonly notifications: UserNotificationService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.notifications.list(user);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user, id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }
}
