# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Gateway signature verification middleware
"""
import hmac
import hashlib
import time
from typing import Optional
from fastapi import Request, HTTPException, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import os


class GatewayAuthMiddleware(BaseHTTPMiddleware):
    """Verify Gateway signature for internal service calls"""
    
    # Skip auth for these paths
    SKIP_PATHS = ["/health/liveness", "/health/readiness", "/docs", "/openapi.json", "/"]
    
    def __init__(self, app, signing_secret: Optional[str] = None):
        super().__init__(app)
        # Get signing secret from environment variable or use default for dev
        self.signing_secret = signing_secret or os.getenv(
            "GW_SIGNING_SECRET", 
            "dev-secret-change-in-production"
        )
    
    async def dispatch(self, request: Request, call_next):
        # Skip auth for health checks and docs
        if any(request.url.path.startswith(path) for path in self.SKIP_PATHS):
            return await call_next(request)
        
        # Extract required headers
        signature = request.headers.get("X-GW-Signature")
        timestamp = request.headers.get("X-GW-Timestamp")
        request_id = request.headers.get("X-Request-Id")
        
        if not all([signature, timestamp, request_id]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": {
                        "code": "INVALID_GW_SIGNATURE",
                        "message": "Missing required gateway headers",
                        "retryable": False
                    }
                }
            )
        
        # Verify timestamp (prevent replay attacks)
        try:
            ts = int(timestamp)
            now = int(time.time())
            if abs(now - ts) > 60:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": {
                            "code": "INVALID_GW_SIGNATURE",
                            "message": "Request timestamp expired",
                            "retryable": False
                        }
                    }
                )
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": {
                        "code": "INVALID_GW_SIGNATURE",
                        "message": "Invalid timestamp format",
                        "retryable": False
                    }
                }
            )
        
        # Read request body
        body = await request.body()
        
        # Verify signature
        if not self._verify_signature(signature, timestamp, request_id, body):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": {
                        "code": "INVALID_GW_SIGNATURE",
                        "message": "Gateway signature verification failed",
                        "retryable": False
                    },
                    "request_id": request_id
                }
            )
        
        # Recreate request with body for downstream handlers
        async def receive():
            return {"type": "http.request", "body": body}
        
        request._receive = receive
        request._body = body
        
        return await call_next(request)
    
    def _verify_signature(self, signature: str, timestamp: str, request_id: str, body: bytes) -> bool:
        """Verify HMAC-SHA256 signature"""
        try:
            # Calculate body hash
            body_hash = hashlib.sha256(body).hexdigest()
            
            # Build canonical string
            canonical_string = f"{timestamp}.{request_id}.{body_hash}"
            
            # Calculate expected signature
            expected_signature = hmac.new(
                self.signing_secret.encode('utf-8'),
                canonical_string.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
            
            # Compare signatures (constant-time comparison)
            provided_sig = signature.replace("sha256=", "")
            return hmac.compare_digest(provided_sig, expected_signature)
        
        except Exception:
            return False
