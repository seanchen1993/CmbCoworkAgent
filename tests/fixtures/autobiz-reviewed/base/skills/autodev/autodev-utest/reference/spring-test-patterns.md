# Spring Boot 2/3 单测参考源文件

编辑约定：用 `<!-- section: 名称 | domain: <域> -->` 标记可渲染小节；合法域为 `fundamentals`、`mvc`、`security`、`websocket`、`persistence`，`*` 表示所有域。单域渲染不超过 400 行，全部 `domain: *` 小节合计不超过 60 行。

源文件导航：

- 通用选择
- Fundamentals
- MVC
- MVC/Security 交界
- Security 公共 API 与版本门
- WebSocket 单元边界
- Persistence

<!-- section: 通用选择 | domain: * -->
## 先选测试边界

| 目标 | 首选边界 |
|---|---|
| 单个类的分支、计算、异常 | 普通 JUnit + Mockito，不启动 Spring |
| MVC 请求映射、序列化、校验、异常响应 | `@WebMvcTest` + `MockMvc` |
| 安全过滤规则与 HTTP 状态 | `@WebMvcTest` + Spring Security Test |
| 消息处理方法内部行为 | 直接调用 `@MessageMapping` 方法 |
| 多层 Bean 接线或真实事务边界 | `@SpringBootTest`，仅在窄切片不足时使用 |

生成前先读取项目现有测试、构建文件和依赖版本；沿用项目的 JUnit、断言库、数据库与容器版本，不为套用示例升级依赖。

公共兼容基线：

- Boot 2/3 的 Spring Bean 替换使用 `org.springframework.boot.test.mock.mockito.MockBean` / `SpyBean`。
- Boot、Framework 或 Security 专属 API 只在标明最低版本的小节使用。
- `@SpringBootTest` 不等于必须启动真实端口；只有跨层接线确实属于测试目标时才加载完整上下文。
- 异步状态用有超时的条件等待，不用固定睡眠。

<!-- section: Fundamentals | domain: fundamentals -->
## Fundamentals

### 普通单元测试

测试单个类时不启动 Spring：

```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {
    @Mock OrderRepository repository;
    @Mock PaymentClient paymentClient;
    @InjectMocks OrderService service;

    @Test
    void place_whenPaymentAccepted_returnsConfirmedOrder() {
        given(repository.findById(42L)).willReturn(Optional.of(anOrder()));
        given(paymentClient.charge(any(Money.class))).willReturn(APPROVED);

        Order result = service.place(42L);

        assertThat(result.getStatus()).isEqualTo(CONFIRMED);
    }
}
```

用真实 DTO、值对象和请求对象。只有被测类边界外的依赖使用 mock。

### Spring 上下文中的 Bean 替换

Boot 2.x 与 3.x：

```java
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.mock.mockito.SpyBean;

@MockBean PaymentClient paymentClient;
@SpyBean AuditService auditService;
```

- `@MockBean` 完全替换上下文中的 Bean；未 stub 的方法返回 Mockito 默认值。
- `@SpyBean` 包装真实 Bean；只有真实 Bean 及其依赖能在当前切片中构造时才使用。
- 切片缺少边界外协作者时可以替换该协作者，不替换被测对象。

### AssertJ

```java
assertThat(user.getEmail()).isEqualTo("alice@example.com");
assertThat(result).isPresent().hasValue(expected);
assertThat(items).extracting(Item::getSku)
    .containsExactly("A-1", "B-2");
assertThat(price).isEqualByComparingTo("9.99");

assertThatThrownBy(() -> service.findById(99L))
    .isInstanceOf(NotFoundException.class)
    .hasMessageContaining("99");
```

`BigDecimal` 使用 `isEqualByComparingTo`，避免比例位数造成与业务数值无关的失败。集合在顺序属于契约时用 `containsExactly`，否则用 `containsExactlyInAnyOrder`。

### BDDMockito 与参数捕获

```java
given(repository.findById(1L)).willReturn(Optional.of(order));
willThrow(new MailException()).given(mailClient).send(any(Message.class));

service.confirm(1L);

then(mailClient).should().send(messageCaptor.capture());
assertThat(messageCaptor.getValue().getOrderId()).isEqualTo(1L);
```

- matcher 与实参不要混用；某个参数使用 matcher 时，其余参数也用 `eq(...)` 等 matcher。
- `ArgumentCaptor` 用于断言传给外部边界的业务载荷，不用它锁定内部对象拼装过程。
- 只有调用本身属于可观察契约时才验证次数或顺序。

### Strict stubbing

未使用的 stub 应删除或移入真正使用它的测试：

```java
@Test
void find_existingId_returnsOrder() {
    given(repository.findById(1L)).willReturn(Optional.of(order));
    assertThat(service.find(1L)).isEqualTo(order);
}
```

不要用类级 lenient 设置掩盖大批无效准备；共享 fixture 只创建数据，不预设每个测试未必使用的调用。

### Spring 上下文缓存

Spring 按测试配置、profile、属性、导入和 Bean 替换集合缓存上下文。保持同类切片的配置稳定；不要为普通数据清理使用 `@DirtiesContext`。

只在测试确实污染 Bean 配置、静态状态或后台线程时使用：

```java
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ContextMutatingTest { }
```

### 异步断言

```java
await()
    .atMost(Duration.ofSeconds(5))
    .untilAsserted(() -> assertThat(outbox.count()).isEqualTo(1));
```

命名采用 `method_scenario_expectedBehavior`，让失败名称直接说明行为，例如 `cancel_whenAlreadyPaid_throwsConflict`。

<!-- section: MVC | domain: mvc -->
## MVC

### MVC 切片

Boot 2.x 与 3.x 的包路径相同：

```java
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(controllers = UserController.class)
class UserControllerTest {
    @Autowired MockMvc mockMvc;
    @Autowired ObjectMapper objectMapper;
    @MockBean UserService userService;
}
```

`@WebMvcTest` 加载 MVC 基础设施、目标 controller、相关转换器、过滤器和 advice，不加载普通 service/repository Bean。始终限定目标 controller；切片外依赖用 mock、fake 或显式 `@Import` 满足。

### 请求与响应

```java
given(userService.findById(42L))
    .willReturn(new UserDto(42L, "alice@example.com"));

mockMvc.perform(get("/users/{id}", 42L)
        .accept(MediaType.APPLICATION_JSON))
    .andExpect(status().isOk())
    .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
    .andExpect(jsonPath("$.id").value(42))
    .andExpect(jsonPath("$.email").value("alice@example.com"));
```

```java
CreateOrderRequest request = new CreateOrderRequest("SKU-1", 2);

mockMvc.perform(post("/orders")
        .contentType(MediaType.APPLICATION_JSON)
        .content(objectMapper.writeValueAsString(request)))
    .andExpect(status().isCreated())
    .andExpect(header().exists("Location"))
    .andExpect(jsonPath("$.status").value("CREATED"));
```

- JSON 使用 `jsonPath` 或反序列化后的对象断言，不比较整段字符串。
- 同时断言状态码与关键响应字段；只断言 `200` 不能证明响应契约正确。
- POST/PUT/PATCH 写 JSON 时设置 `contentType`。

### Bean Validation 的 Boot 2/3 分叉

| 版本 | `@Valid` import |
|---|---|
| Boot 2.x | `javax.validation.Valid` |
| Boot 3.x | `jakarta.validation.Valid` |

controller 保持项目当前版本的 import，测试侧验证无效输入的外部结果：

```java
mockMvc.perform(post("/orders")
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"sku\":\"\",\"quantity\":0}"))
    .andExpect(status().isBadRequest())
    .andExpect(jsonPath("$.errors[*].field", hasItems("sku", "quantity")));
```

### 异常响应与 advice

```java
given(userService.findById(99L)).willThrow(new UserNotFoundException(99L));

mockMvc.perform(get("/users/{id}", 99L))
    .andExpect(status().isNotFound())
    .andExpect(jsonPath("$.message").value(containsString("99")));
```

如果目标 advice 不在切片扫描范围，显式 `@Import(TargetAdvice.class)`；不要为了让异常测试通过复制一份测试专用 handler。

### Multipart

```java
MockMultipartFile file = new MockMultipartFile(
    "file", "avatar.png", MediaType.IMAGE_PNG_VALUE, bytes);

mockMvc.perform(multipart("/users/{id}/avatar", 1L).file(file))
    .andExpect(status().isOk());
```

### 何时扩大到完整上下文

只有目标同时包含真实 Bean 接线、多个业务层或事务边界时使用：

```java
@SpringBootTest
@AutoConfigureMockMvc
class OrderHttpIntegrationTest {
    @Autowired MockMvc mockMvc;
}
```

仍由 `MockMvc` 驱动请求，不需要真实端口。

<!-- section: MVC 与 Security 交界 | domain: mvc,security -->
## MVC 与 Security 的切片交界

项目引入 Spring Security 后，`@WebMvcTest` 会应用安全过滤链。根据测试目标选择：

- 测 HTTP 安全规则：保留过滤链，覆盖未认证、权限不足和授权成功。
- 测 controller 行为但安全配置是必要依赖：导入项目的安全配置或最小测试配置，并提供合法认证。
- 不通过关闭全部过滤器把受保护接口变成无保护接口。

```java
mockMvc.perform(get("/orders/{id}", 1L).with(user("alice").roles("USER")))
    .andExpect(status().isOk());
```

<!-- section: Security 公共测试 API | domain: security -->
## Security

### Security 5/6 全代公共测试 API

```java
@Test
@WithMockUser(username = "alice", roles = "USER")
void getOrder_asUser_returns200() throws Exception {
    mockMvc.perform(get("/orders/{id}", 1L))
        .andExpect(status().isOk());
}
```

每条受保护 HTTP 契约按需要覆盖：

| 场景 | 常见结果 |
|---|---|
| 未认证 | `401`，或项目约定的登录重定向 |
| 已认证但权限不足 | `403` |
| 已认证且授权 | 业务成功状态 |

`roles = "ADMIN"` 生成 `ROLE_ADMIN`；不要写 `roles = "ROLE_ADMIN"`。配置使用 `hasAuthority("orders:read")` 时，测试改用 `authorities = "orders:read"`。

需要真实 principal 类型时使用项目中的 `UserDetailsService`：

```java
@WithUserDetails(
    value = "alice@example.com",
    userDetailsServiceBeanName = "userDetailsService"
)
```

请求级认证与 CSRF：

```java
mockMvc.perform(post("/orders")
        .with(user("alice").roles("USER"))
        .with(csrf())
        .contentType(MediaType.APPLICATION_JSON)
        .content(orderJson))
    .andExpect(status().isCreated());
```

会话型应用的修改请求缺少 CSRF token 时通常返回 `403`。只有生产配置本身是无状态且禁用 CSRF 时，测试配置才保持相同策略；不要只为通过测试关闭安全能力。

认证结果可直接断言：

```java
mockMvc.perform(get("/profile").with(user("alice").roles("USER")))
    .andExpect(authenticated().withUsername("alice"));
```

<!-- section: Security JWT 版本门 | domain: security -->
### JWT：Security 5.2+ / Security 6

`jwt()` 从 Spring Security 5.2 起可用：

```java
mockMvc.perform(get("/messages")
        .with(jwt().authorities(
            new SimpleGrantedAuthority("SCOPE_messages:read"))))
    .andExpect(status().isOk());

mockMvc.perform(get("/messages").with(jwt()))
    .andExpect(status().isForbidden());
```

它构造测试用认证，不联系真实授权服务器。Security 5.0/5.1 项目不要生成该调用，应沿用项目已有的认证测试工具或显式构造 `Authentication`。

<!-- section: Security OAuth2 版本门 | domain: security -->
### OAuth2 Login：Security 5.3+ / Security 6

```java
mockMvc.perform(get("/profile")
        .with(oauth2Login().attributes(attributes ->
            attributes.put("email", "alice@example.com"))))
    .andExpect(status().isOk());
```

OIDC 场景使用同版本提供的 `oidcLogin()`。Security 5.0–5.2 项目不要生成这两个 post-processor。

<!-- section: Security 5 配置 | domain: security -->
### Security 5 / Boot 2 配置示例

以下只展示代次语法；仅当生产应用本身为无状态配置时禁用 CSRF。适用于整个 Security 5 代的保守写法：

```java
@Configuration
@EnableWebSecurity
class Security5Config extends WebSecurityConfigurerAdapter {
    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http.authorizeRequests()
            .antMatchers("/public/**").permitAll()
            .anyRequest().authenticated()
            .and()
            .csrf().disable();
    }
}
```

方法安全使用 `@EnableGlobalMethodSecurity(prePostEnabled = true)`。Security 5.7/5.8 中该基类虽已弃用但仍存在；已有项目若采用 5.8 过渡式 lambda，测试沿用项目配置，不混入 Security 6 才成立的假设。

<!-- section: Security 6 配置 | domain: security -->
### Security 6 / Boot 3 配置示例

同样仅在生产应用采用无状态配置时禁用 CSRF：

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
class Security6Config {
    @Bean
    SecurityFilterChain applicationSecurity(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(authorize -> authorize
                .requestMatchers("/public/**").permitAll()
                .anyRequest().authenticated())
            .csrf(csrf -> csrf.disable());
        return http.build();
    }
}
```

测试中的 `@TestConfiguration` 只提供目标测试所需的最小安全规则，并与目标项目的 Security 代次一致。

### 方法安全

`@PreAuthorize` 属于代理行为；直接 `new` service 不会触发。使用包含目标 service 与对应方法安全配置的最小 Spring 上下文，断言允许调用的结果与拒绝调用的 `AccessDeniedException`。

<!-- section: WebSocket | domain: websocket -->
## WebSocket 单元边界

### 直接测试消息处理方法

`@MessageMapping` 方法的参数转换完成后，如果内部只是普通业务逻辑，直接调用：

```java
class ChatControllerTest {
    private final ChatService service = mock(ChatService.class);
    private final ChatController controller = new ChatController(service);

    @Test
    void send_validCommand_returnsMessage() {
        SendMessage command = new SendMessage("Hello");
        given(service.send("alice", "Hello")).willReturn(aMessage());

        ChatMessage result = controller.send(command, () -> "alice");

        assertThat(result.getSender()).isEqualTo("alice");
        assertThat(result.getContent()).isEqualTo("Hello");
    }
}
```

该测试覆盖方法行为，不证明 destination 映射、broker 路由或订阅投递正确。

### 消息转换

转换规则是目标时，直接测试项目使用的 converter 和 payload 类型：

```java
MappingJackson2MessageConverter converter = new MappingJackson2MessageConverter();
Message<byte[]> message = MessageBuilder
    .withPayload("{\"content\":\"Hello\"}".getBytes(StandardCharsets.UTF_8))
    .setHeader(MessageHeaders.CONTENT_TYPE, MimeTypeUtils.APPLICATION_JSON)
    .build();

SendMessage result = (SendMessage) converter.fromMessage(message, SendMessage.class);
assertThat(result.getContent()).isEqualTo("Hello");
```

如果项目定制了 `ObjectMapper`、content type 或 converter 顺序，测试显式应用同一配置。

### 消息级鉴权

- handler 接收 `Principal` 时，直接覆盖合法用户、缺失用户和不匹配用户。
- 业务授权规则放在可独立调用的 policy/service 中，普通单元测试覆盖允许与拒绝。
- 注解或消息安全拦截器属于代理/基础设施行为；需要 Spring 上下文时只加载目标配置，不把真实连接混入单元测试。

### 交接到 E2E

以下不属于本参考：真实端口、WebSocket/STOMP 握手、broker 路由、广播、用户队列端到端投递、连接超时与会话释放。它们交给 E2E 测试。

避免用 `Thread.sleep()` 等待消息，也不通过断言 broker 内部调用证明投递完成。

<!-- section: Persistence | domain: persistence -->
## Persistence

本节只描述数据源、事务和存储可观察性，不使用任何持久化框架专有 API。

### 测试数据库选择

| 测试目标 | 数据库选择 |
|---|---|
| 纯映射、参数校验、与 SQL 方言无关的简单路径 | 可沿用项目已有测试数据库 |
| 原生 SQL、方言函数、DDL、迁移、锁、事务隔离、约束 | 使用与生产同类的数据库，优先 Testcontainers |

不要把某一种测试数据库写成全局禁令；选择由当前测试要验证的数据库语义决定。

### Testcontainers：早期 Boot 2 回退

不具备 `@DynamicPropertySource` 的早期 Boot 2 使用 `ApplicationContextInitializer` + `TestPropertyValues`：

```java
@SpringBootTest
@ContextConfiguration(initializers = DatabaseTest.Initializer.class)
class DatabaseTest {
    static final PostgreSQLContainer<?> database =
        new PostgreSQLContainer<>("postgres:12-alpine");

    static class Initializer
            implements ApplicationContextInitializer<ConfigurableApplicationContext> {
        @Override
        public void initialize(ConfigurableApplicationContext context) {
            database.start();
            TestPropertyValues.of(
                "spring.datasource.url=" + database.getJdbcUrl(),
                "spring.datasource.username=" + database.getUsername(),
                "spring.datasource.password=" + database.getPassword()
            ).applyTo(context.getEnvironment());
        }
    }
}
```

容器实例须在上下文读取属性前启动，并在测试套件内复用；不要为每个测试方法重启数据库容器。

### Testcontainers：Framework 5.2.5+

```java
@Testcontainers
@SpringBootTest
class DatabaseTest {
    @Container
    static final PostgreSQLContainer<?> database =
        new PostgreSQLContainer<>("postgres:14-alpine");

    @DynamicPropertySource
    static void databaseProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", database::getJdbcUrl);
        registry.add("spring.datasource.username", database::getUsername);
        registry.add("spring.datasource.password", database::getPassword);
    }
}
```

`@DynamicPropertySource` 从 Spring Framework 5.2.5 起可用，Boot 2/3 均可继续使用。

### Testcontainers：Boot 3.1+

```java
@TestConfiguration(proxyBeanMethods = false)
class DatabaseContainerConfig {
    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> database() {
        return new PostgreSQLContainer<>("postgres:16-alpine");
    }
}

@SpringBootTest
@Import(DatabaseContainerConfig.class)
class DatabaseTest { }
```

`@ServiceConnection` 从 Boot 3.1 起可用。使用共享测试配置，避免不同测试类创建内容相同但缓存键不同的上下文。
该注解还要求项目测试依赖中包含 Boot 3.1+ 的 `spring-boot-testcontainers`；依赖不存在时继续使用上一节写法。

### 事务边界

测试类上的 `@Transactional` 会把准备、调用和断言合并进同一测试事务，并在结束时回滚。它适合只关心事务内行为且需要自动清理的测试；以下目标不要依赖测试级事务：

- 生产代码提交后的可见性；
- 多事务协作、异步消费者或新线程读取；
- 锁、隔离级别、提交时约束；
- 生产 service 方法自身的事务边界。

这些测试应让生产代码按真实边界提交，并在测试前显式清理数据。

### 数据准备、验证与清理

- 测读取：用独立持久化通道准备已知数据，再调用被测读取接口。
- 测写入：调用被测写入接口，再用独立持久化通道核对已持久化结果。
- 不用被测组件本身同时完成准备、动作和验证。
- 断言读取应绕开可能返回同一内存对象的会话或客户端缓存，确保观察到存储状态。
- 在每个测试前清理；失败或中断时，测试后的清理可能不会执行。

复杂数据可使用 Spring Test 的 `@Sql`：

```java
@Test
@Sql("/test-data/orders.sql")
void findOpenOrders_returnsPreparedRows() { }
```

清理脚本或共享测试工具要处理外键顺序，并与项目迁移后的表结构同步。

### 应覆盖的存储行为

- 项目自定义 SQL 与结果映射；
- 唯一键、外键、检查约束和错误转换；
- 生产数据库特有函数、类型与排序；
- 并发更新、锁与事务隔离；
- 写入后由独立读取观察到的完整字段。

异步持久化结果使用 Awaitility 的有界轮询，不用固定睡眠。
