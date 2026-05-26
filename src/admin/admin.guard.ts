import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = (req.headers as any)["authorization"] ?? "";
    const secret = this.configService.get<string>("admin.apiSecret") ?? "";

    if (!secret || header !== `Bearer ${secret}`) {
      throw new UnauthorizedException("Acceso denegado");
    }
    return true;
  }
}
