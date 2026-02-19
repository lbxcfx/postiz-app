# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
V1 Jobs API Router according to API.md specification
"""
from fastapi import APIRouter, HTTPException, Header, status
from typing import Optional
from uuid import UUID

from ..schemas.job import (
    CreateJobRequest,
    CreateJobResponse,
    GetJobStatusResponse,
    GetJobResultResponse,
    ErrorResponse,
    ErrorDetail,
)
from ..services.job_service import job_service

router = APIRouter(prefix="/v1/jobs", tags=["v1-jobs"])


@router.post("", response_model=CreateJobResponse, status_code=status.HTTP_201_CREATED)
async def create_job(
    request: CreateJobRequest,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    x_tenant_id: Optional[str] = Header(None, alias="X-Tenant-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """Create a new crawl job"""
    # Use idempotency key from header if not in body
    if not request.idempotency_key and idempotency_key:
        request.idempotency_key = idempotency_key
    
    result, error = await job_service.create_job(
        request=request,
        tenant_id=x_tenant_id,
        user_id=x_user_id
    )
    
    if error:
        if error.error.code == "IDEMPOTENCY_CONFLICT":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=error.model_dump()
            )
        elif error.error.code == "NON_RETRYABLE_VALIDATION":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error.model_dump()
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error.model_dump()
            )
    
    return CreateJobResponse(**result)


@router.get("/{job_id}", response_model=GetJobStatusResponse)
async def get_job_status(job_id: str):
    """Get job status"""
    try:
        # Validate UUID format
        UUID(job_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "NON_RETRYABLE_VALIDATION",
                    "message": "Invalid job_id format",
                    "retryable": False
                }
            }
        )
    
    result = await job_service.get_job_status(job_id)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": {
                    "code": "NOT_FOUND",
                    "message": f"Job {job_id} not found",
                    "retryable": False
                }
            }
        )
    
    return result


@router.get("/{job_id}/result", response_model=GetJobResultResponse)
async def get_job_result(job_id: str):
    """Get job result"""
    try:
        # Validate UUID format
        UUID(job_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "NON_RETRYABLE_VALIDATION",
                    "message": "Invalid job_id format",
                    "retryable": False
                }
            }
        )
    
    result = await job_service.get_job_result(job_id)
    
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": {
                    "code": "NOT_FOUND",
                    "message": f"Job {job_id} not found",
                    "retryable": False
                }
            }
        )
    
    return result
