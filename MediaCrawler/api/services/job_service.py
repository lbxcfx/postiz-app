# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Job service for managing crawl jobs
"""
import asyncio
import hashlib
import json
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple
from uuid import UUID

from ..schemas.job import (
    CreateJobRequest,
    JobStatusEnum,
    CrawlPayload,
    GetJobStatusResponse,
    JobProgress,
    GetJobResultResponse,
    JobOutput,
    ContentItem,
    ErrorResponse,
    ErrorDetail,
)


class JobService:
    """Service for managing crawl jobs"""
    
    def __init__(self):
        # In-memory job storage (in production, use Redis or database)
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._idempotency_keys: Dict[str, str] = {}  # idempotency_key -> job_id
        self._job_results: Dict[str, Any] = {}
        self._lock = asyncio.Lock()
    
    async def create_job(
        self, 
        request: CreateJobRequest,
        tenant_id: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> Tuple[Optional[Dict], Optional[ErrorResponse]]:
        """Create a new crawl job"""
        async with self._lock:
            # Validate payload
            try:
                request.payload.model_validate_payload()
            except ValueError as e:
                return None, ErrorResponse(
                    error=ErrorDetail(
                        code="NON_RETRYABLE_VALIDATION",
                        message=str(e),
                        retryable=False
                    )
                )
            
            # Handle idempotency
            idempotency_key = request.idempotency_key
            if idempotency_key:
                # Calculate payload hash for comparison
                payload_hash = self._calculate_payload_hash(request.payload)
                
                if idempotency_key in self._idempotency_keys:
                    existing_job_id = self._idempotency_keys[idempotency_key]
                    existing_job = self._jobs.get(existing_job_id)
                    
                    if existing_job:
                        # Check if payload matches
                        existing_hash = existing_job.get("payload_hash")
                        if existing_hash != payload_hash:
                            return None, ErrorResponse(
                                error=ErrorDetail(
                                    code="IDEMPOTENCY_CONFLICT",
                                    message="Idempotency key exists but payload hash mismatch",
                                    retryable=False,
                                    details={"existing_job_id": existing_job_id}
                                )
                            )
                        # Return existing job
                        return {
                            "job_id": existing_job_id,
                            "status": existing_job["status"],
                            "created_at": existing_job["created_at"]
                        }, None
                
                # Store idempotency key
                job_id = str(uuid.uuid4())
                self._idempotency_keys[idempotency_key] = job_id
            else:
                job_id = str(uuid.uuid4())
            
            # Create job record
            now = datetime.utcnow()
            job_record = {
                "job_id": job_id,
                "job_type": request.job_type,
                "status": JobStatusEnum.PENDING,
                "payload": request.payload.model_dump(),
                "payload_hash": self._calculate_payload_hash(request.payload),
                "tenant_id": tenant_id,
                "user_id": user_id,
                "created_at": now,
                "started_at": None,
                "updated_at": now,
                "progress": {
                    "total": 0,
                    "completed": 0,
                    "failed": 0
                },
                "error": None,
                "content_items": [],
                "artifacts": []
            }
            
            self._jobs[job_id] = job_record
            
            # Start job execution asynchronously
            asyncio.create_task(self._execute_job(job_id))
            
            return {
                "job_id": job_id,
                "status": JobStatusEnum.PENDING,
                "created_at": now
            }, None
    
    async def get_job_status(self, job_id: str) -> Optional[GetJobStatusResponse]:
        """Get job status"""
        job = self._jobs.get(job_id)
        if not job:
            return None
        
        progress = None
        if job["status"] in [JobStatusEnum.RUNNING, JobStatusEnum.SUCCEEDED]:
            progress = JobProgress(**job["progress"])
        
        return GetJobStatusResponse(
            job_id=job["job_id"],
            job_type=job["job_type"],
            status=job["status"],
            progress=progress,
            error=job.get("error"),
            created_at=job["created_at"],
            started_at=job.get("started_at"),
            updated_at=job["updated_at"]
        )
    
    async def get_job_result(self, job_id: str) -> Optional[GetJobResultResponse]:
        """Get job result"""
        job = self._jobs.get(job_id)
        if not job:
            return None
        
        output = None
        if job["status"] == JobStatusEnum.SUCCEEDED and job.get("content_items"):
            payload = CrawlPayload(**job["payload"])
            output = JobOutput(
                platform=payload.platform.value,
                mode=payload.mode.value,
                keyword=payload.keyword,
                total_count=len(job["content_items"]),
                content_items=[ContentItem(**item) for item in job["content_items"]]
            )
        
        artifacts = None
        if job.get("artifacts"):
            artifacts = job["artifacts"]
        
        return GetJobResultResponse(
            job_id=job_id,
            output=output,
            artifacts=artifacts
        )
    
    async def _execute_job(self, job_id: str):
        """Execute crawl job"""
        job = self._jobs.get(job_id)
        if not job:
            return
        
        try:
            # Update status to RUNNING
            job["status"] = JobStatusEnum.RUNNING
            job["started_at"] = datetime.utcnow()
            job["updated_at"] = datetime.utcnow()
            
            # Import crawler executor
            from .crawl_executor import CrawlExecutor
            
            executor = CrawlExecutor()
            result = await executor.execute(
                job_id=job_id,
                payload=CrawlPayload(**job["payload"]),
                progress_callback=lambda progress: self._update_progress(job_id, progress),
                item_callback=lambda item: self._add_content_item(job_id, item)
            )
            
            if result["success"]:
                job["status"] = JobStatusEnum.SUCCEEDED
                job["artifacts"] = result.get("artifacts", [])
            else:
                job["status"] = JobStatusEnum.FAILED
                job["error"] = result.get("error", "Unknown error")
            
        except Exception as e:
            job["status"] = JobStatusEnum.FAILED
            job["error"] = str(e)
        finally:
            job["updated_at"] = datetime.utcnow()
    
    def _update_progress(self, job_id: str, progress: Dict[str, int]):
        """Update job progress"""
        job = self._jobs.get(job_id)
        if job:
            job["progress"].update(progress)
            job["updated_at"] = datetime.utcnow()
    
    def _add_content_item(self, job_id: str, item: Dict):
        """Add content item to job result"""
        job = self._jobs.get(job_id)
        if job:
            if "content_items" not in job:
                job["content_items"] = []
            job["content_items"].append(item)
            job["updated_at"] = datetime.utcnow()
    
    def _calculate_payload_hash(self, payload: CrawlPayload) -> str:
        """Calculate payload hash for idempotency check"""
        payload_dict = payload.model_dump(exclude_none=True, mode='json')
        payload_str = json.dumps(payload_dict, sort_keys=True)
        return hashlib.sha256(payload_str.encode()).hexdigest()


# Global singleton
job_service = JobService()
