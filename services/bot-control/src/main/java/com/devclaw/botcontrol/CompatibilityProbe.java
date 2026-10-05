package com.devclaw.botcontrol;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;

/** Compatibility executable only. No API, DTO, persistence, or service listener. */
public final class CompatibilityProbe {
    private CompatibilityProbe() { }

    public static ObjectMapper strictMapper() {
        JsonFactory factory = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).maxNumberLength(128).maxStringLength(1048576).build()).build();
        return new ObjectMapper(factory).enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(DeserializationFeature.USE_BIG_INTEGER_FOR_INTS)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));
    }

    public static JsonNode strictRead(byte[] bytes) throws Exception {
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        return strictMapper().readTree(text);
    }

    public static void jsonCompatibility() throws Exception {
        check("2.18.3".equals(strictMapper().version().toString()), "jackson version");
        check(strictRead("9007199254740993".getBytes(StandardCharsets.UTF_8)).bigIntegerValue().equals(new BigInteger("9007199254740993")), "integer precision");
        for (String value : new String[]{"1", "1.0", "1e0"}) check(strictRead(value.getBytes(StandardCharsets.UTF_8)).decimalValue().stripTrailingZeros().toPlainString().equals("1"), "integer equivalence");
        for (String value : new String[]{"{\"x\":1,\"x\":2}", "{} {}", "/*x*/{}", "NaN", "{\"x\":01}", "{\"x\":'x'}"}) {
            boolean rejected = false;
            try { strictRead(value.getBytes(StandardCharsets.UTF_8)); } catch (Exception expected) { rejected = true; }
            check(rejected, "strict json rejection");
        }
        boolean rejected = false;
        try { strictRead(new byte[]{34, (byte) 0xc0, (byte) 0xaf, 34}); } catch (Exception expected) { rejected = true; }
        check(rejected, "utf8 rejection");
    }

    public static void schemaCompatibility() throws Exception {
        SchemaValidatorsConfig config = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).typeLoose(false).build();
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(VersionFlag.V202012);
        JsonSchema schema = factory.getSchema(strictMapper().readTree("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"array\",\"prefixItems\":[{\"type\":\"string\",\"format\":\"date-time\"}],\"items\":false}"), config);
        check(schema.validate(strictMapper().readTree("[\"2026-10-05T00:00:00Z\"]")).isEmpty(), "2020-12 valid");
        check(!schema.validate(strictMapper().readTree("[\"not-a-date\"]")).isEmpty(), "format assertion");
        check(!schema.validate(strictMapper().readTree("[\"2026-10-05T00:00:00Z\",1]")).isEmpty(), "prefixItems dialect");
        check(!schema.validate(strictMapper().readTree("[1]")).isEmpty(), "no type coercion");
    }

    public static void loggingCompatibility() throws Exception {
        check("2.0.17".equals(org.slf4j.helpers.SubstituteLoggerFactory.class.getPackage().getImplementationVersion()), "slf4j version");
        check(LoggerFactory.getILoggerFactory().getClass().getName().equals("org.apache.logging.slf4j.Log4jLoggerFactory"), "single log4j2 provider");
        Enumeration<java.net.URL> providers = CompatibilityProbe.class.getClassLoader().getResources("META-INF/services/org.slf4j.spi.SLF4JServiceProvider");
        check(Collections.list(providers).size() == 1, "provider count");
        check(!CompatibilityProbe.class.getClassLoader().getResources("org/slf4j/impl/StaticLoggerBinder.class").hasMoreElements(), "no old binding");
        for (String unwanted : new String[]{"ch.qos.logback.classic.LoggerContext", "org.apache.logging.slf4j.SLF4JLoggerContext"}) {
            boolean absent = false;
            try { Class.forName(unwanted); } catch (ClassNotFoundException expected) { absent = true; }
            check(absent, "no bridge loop");
        }
        LoggerFactory.getLogger(CompatibilityProbe.class).info("B01_A1_LOGGING_PROBE");
    }

    @Configuration
    @EnableAutoConfiguration(exclude = {DataSourceAutoConfiguration.class, FlywayAutoConfiguration.class})
    public static class ProbeConfiguration { }

    public static void bootCompatibility() {
        check(System.getProperty("java.version").equals("1.8.0_482"), "real java8");
        check(System.getProperty("java.vendor").contains("Amazon"), "corretto");
        check("2.7.18".equals(SpringBootVersion.getVersion()), "boot version");
        SpringApplication application = new SpringApplication(ProbeConfiguration.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        application.setDefaultProperties(Collections.singletonMap("spring.main.banner-mode", "off"));
        try (ConfigurableApplicationContext context = application.run()) {
            check(context.getBeansOfType(javax.sql.DataSource.class).isEmpty(), "no datasource");
            check(context.getBeansOfType(org.springframework.boot.web.server.WebServer.class).isEmpty(), "no web server");
            check(context.getClass().getName().equals("org.springframework.context.annotation.AnnotationConfigApplicationContext"), "non-web context");
        }
    }

    private static void check(boolean condition, String category) { if (!condition) throw new IllegalStateException("B01_A1_" + category.replace(' ', '_').toUpperCase(java.util.Locale.ROOT)); }
    public static void main(String[] args) {
        try {
            jsonCompatibility(); schemaCompatibility(); loggingCompatibility(); bootCompatibility();
            System.out.println("{\"status\":\"verified\",\"compatibilityGroups\":4,\"java\":\"1.8.0_482\",\"boot\":\"2.7.18\",\"jackson\":\"2.18.3\",\"schema\":\"2020-12_format_asserted\",\"logging\":\"SLF4J2_Log4j2_single_provider\",\"web\":false,\"database\":false}");
        } catch (Throwable failure) {
            System.err.println("{\"status\":\"failed\",\"reason\":\"B01_A1_COMPATIBILITY\"}");
            System.exit(1);
        }
    }
}
