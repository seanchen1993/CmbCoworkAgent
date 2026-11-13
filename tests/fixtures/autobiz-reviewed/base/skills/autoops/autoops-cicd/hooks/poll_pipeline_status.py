#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流水线构建状态轮询脚本
入参: pipelineCode(流水线编号), pipelineNum(流水线构建号)
轮询接口获取构建状态，构建中时每30秒轮询一次，最多轮询20分钟
"""

import argparse
import sys
import time

import requests


POLL_INTERVAL = 30  # 轮询间隔（秒）
MAX_POLL_TIME = 20 * 60  # 最大轮询时长（秒）
API_BASE_URL = "http://archguardservice.paas.cmbchina.cn/arch-check/v1/pipeline/get-pipeline-build-status"


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(description="轮询流水线构建状态")
    parser.add_argument("--pipelineCode", required=True, help="流水线编号")
    parser.add_argument("--pipelineNum", required=True, help="流水线构建号")
    return parser.parse_args()


def get_build_status(pipeline_code: str, pipeline_num: str) -> str:
    """
    调用接口获取流水线构建状态

    Args:
        pipeline_code: 流水线编号
        pipeline_num: 流水线构建号

    Returns:
        str: 构建状态
    """
    url = f"{API_BASE_URL}?pipelineCode={pipeline_code}&pipelineNum={pipeline_num}"
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()

        if not response.text or response.text.strip() == "":
            return "获取状态失败: 空响应"

        return response.text.strip()

    except requests.exceptions.RequestException as e:
        print(f"请求接口异常: {str(e)}", file=sys.stderr)
        sys.exit(1)


def poll_build_status(pipeline_code: str, pipeline_num: str) -> str:
    """
    轮询流水线构建状态

    Args:
        pipeline_code: 流水线编号
        pipeline_num: 流水线构建号

    Returns:
        str: 最终构建状态
    """
    start_time = time.time()
    poll_count = 0

    while True:
        elapsed_time = time.time() - start_time

        if elapsed_time >= MAX_POLL_TIME:
            print(f"\n轮询超时（已轮询 {int(elapsed_time)} 秒，超过最大限制 {MAX_POLL_TIME} 秒）")
            return "构建中"

        status = get_build_status(pipeline_code, pipeline_num)
        poll_count += 1

        print(f"第 {poll_count} 次轮询，耗时 {int(elapsed_time)} 秒，当前状态: {status}")

        if status != "构建中":
            return status

        sleep_time = POLL_INTERVAL - (time.time() - start_time - elapsed_time)
        if sleep_time > 0:
            time.sleep(sleep_time)


def main():
    args = parse_args()

    print("开始轮询流水线构建状态...")
    print(f"流水线编号: {args.pipelineCode}")
    print(f"流水线构建号: {args.pipelineNum}")
    print(f"轮询间隔: {POLL_INTERVAL} 秒，最大轮询时长: {MAX_POLL_TIME // 60} 分钟\n")

    final_status = poll_build_status(args.pipelineCode, args.pipelineNum)

    print(f"\n最终构建状态: {final_status}")
    return final_status


if __name__ == "__main__":
    result = main()
    sys.exit(0 if result == "构建成功" else 1)
