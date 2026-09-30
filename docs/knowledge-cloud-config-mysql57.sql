-- 组织知识库配置 MySQL 5.7 基线 DDL；MySQL 8.0 亦可使用。
-- 仅为设计交付，不由客户端或应用启动自动执行。
-- 所有连接均须使用严格 SQL mode，并初始化 session time_zone = '+08:00'。
-- DATETIME 保存 GMT+8 墙上时间；API 输出 YYYY-MM-DD HH:mm:ss，无 ISO T。
-- id_key 是不可变的内部标识；name 是全局唯一业务名称，目录名不直接使用 name。
-- name 人工写入时不得为空或带首尾空白；查询接口只校验，不清洗、不改写。
-- name 判重采用本表 utf8mb4_general_ci 排序规则，大小写差异不能作为不同名称。
-- 同仓库不同分支使用不同 id_key 和 name，不增加仓库加分支唯一约束。
-- 此文件为目标基线；已有表结构和同名数据如何调整须另行确认，不自动迁移。
-- MySQL 5.7 不执行 CHECK 约束，字段格式及业务有效性由服务端校验。
-- enable_org 存储 JSON 字符串：{"global":true,"orgNames":[]} 或 {"global":false,"orgNames":["a组","b室"]}。
-- 不使用外键、触发器、级联或关联更新；一期由人工维护此表。
-- 不用 IF NOT EXISTS，避免静默忽略已有不一致结构。

CREATE TABLE devclaw_knowledge_config (
                                        id_key VARCHAR(40) NOT NULL COMMENT '不可变的知识库标识',
                                        name VARCHAR(128)  NOT NULL COMMENT '全局唯一知识库名称',
                                        description VARCHAR(300)  NOT NULL COMMENT '知识库描述',
                                        repo_url VARCHAR(2048) NOT NULL COMMENT 'Git地址',
                                        ssh_url VARCHAR(2048) NULL COMMENT 'SSH地址',
                                        git_ref VARCHAR(255) NOT NULL DEFAULT 'main' COMMENT '指定分支',
                                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'GMT+8',
                                        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'GMT+8',
                                        owner_name varchar(64) NOT NULL COMMENT '发布人姓名',
                                        owner_id varchar(32) NOT NULL COMMENT '发布人id',
                                        enable_org VARCHAR(1000) NOT NULL COMMENT '生效组织名称范围，JSON字符串',
                                        devops_id varchar(32) NOT NULL COMMENT 'devops账号',
                                        devops_key VARCHAR(128) NOT NULL COMMENT 'devopskey,用于发起知识沉淀更新',
                                        custom_config VARCHAR(2048) NOT NULL COMMENT '知识库个性化配置',
                                        PRIMARY KEY (id_key),
                                        UNIQUE KEY uk_km_knowledge_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='知识库定义';
