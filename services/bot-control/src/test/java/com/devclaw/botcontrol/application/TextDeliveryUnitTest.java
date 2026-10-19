package com.devclaw.botcontrol.application;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.TransactionObserver;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class TextDeliveryUnitTest {
    @Test void reviewShapeDoesNotPretendUnexecutedStagesCompleted(){
        Task task=new Task();task.stages=new ArrayList<Stage>();for(StageKind kind:StageKind.values()){Stage s=new Stage();s.kind=kind;task.stages.add(s);}
        for(String state:Arrays.asList("awaiting_business","active","completed")){
            TextDeliveryApplication.shape(task,state);assertEquals(state,task.status.wire());
            assertEquals(state.equals("active")?StageStatus.ACTIVE:state.equals("completed")?StageStatus.COMPLETED:StageStatus.WAITING_CONFIRMATION,task.stages.get(0).status);
            for(int i=1;i<task.stages.size();i++)assertEquals(state.equals("completed")?StageStatus.CANCELLED:StageStatus.PENDING,task.stages.get(i).status);
        }
    }
    @Test void missingActorAndInvalidDecisionsNeverOpenDatabase(){
        AtomicInteger calls=new AtomicInteger();TextDeliveryApplication app=new TextDeliveryApplication(ApplicationUnitTest.unavailable(calls),ApplicationUnitTest.policy(true),TransactionObserver.NONE);
        assertEquals(ErrorCode.UNAUTHENTICATED,assertThrows(ApplicationFault.class,()->app.publish(null,"command","task","run",1,0)).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.decide(ApplicationUnitTest.ACTOR,"command","task","version",1,1,"reject"," ")).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.decide(ApplicationUnitTest.ACTOR,"command","task","version",1,1,"approve","comment")).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.summaries(ApplicationUnitTest.ACTOR,Arrays.asList("task","task"))).code);assertEquals(0,calls.get());
    }
}
